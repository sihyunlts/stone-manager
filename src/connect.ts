import { invoke } from "@tauri-apps/api/core";
import { renderList, renderListItem } from "./components/list";
import type { ConnectionState } from "./state/connection";
import {
  getRegisteredDevices,
  removeRegisteredDevice,
  upsertRegisteredDevice,
} from "./state/devices";

export type DeviceInfo = {
  name: string;
  address: string;
  connected: boolean;
  alias?: string | null;
  raw_name?: string | null;
};

export type { ConnectionState } from "./state/connection";

export type ConnectResultEvent = {
  address: string;
  ok: boolean;
  error?: string | null;
};

export type DeviceStateEvent = {
  address: string;
  connected: boolean;
};

type ConnectionInfo = {
  address: string | null;
  link: boolean;
  rfcomm: boolean;
};

type ConnectControllerDeps = {
  logLine: (line: string, tone?: "IN" | "OUT" | "SYS") => void;
  getConnectionState: () => ConnectionState;
  getConnectedAddress: () => string | null;
  setConnectionState: (state: ConnectionState, address?: string | null) => void;
  setConnected: (address: string) => void;
  setDisconnected: () => void;
};

export function initConnectController(deps: ConnectControllerDeps) {
  const registerList = document.querySelector<HTMLDivElement>("#registerList");
  const registeredList = document.querySelector<HTMLDivElement>("#registeredList");
  const activeList = document.querySelector<HTMLDivElement>("#activeList");
  const registerButton = document.querySelector<HTMLButtonElement>("#registerDevice");

  let devices: DeviceInfo[] = [];
  let registerSelected = "";
  let registeredSelected = "";
  let registerPending: string | null = null;

  function getDeviceLabel(address: string) {
    const device = devices.find((d) => d.address === address);
    if (device?.name) return device.name;
    const paired = getRegisteredDevices().find((d) => d.address === address);
    return paired?.name ?? address;
  }

  function selectRegister(address: string) {
    registerSelected = address;
    registerList?.querySelectorAll(".device-item").forEach((item) => {
      item.classList.toggle("is-selected", item.getAttribute("data-address") === address);
    });
  }

  function selectRegistered(address: string) {
    registeredSelected = address;
    registeredList?.querySelectorAll(".device-item").forEach((item) => {
      item.classList.toggle("is-selected", item.getAttribute("data-address") === address);
    });
  }

  function renderRegisterList() {
    if (!registerList) return;
    const connectedDevices = devices.filter((d) => d.connected);
    if (connectedDevices.length === 0) {
      registerSelected = "";
      registerList.innerHTML = renderList([
        renderListItem({
          label: "연결된 기기가 없습니다.",
          value: "",
          className: "device-item-empty",
        }),
      ]);
      return;
    }
    registerList.innerHTML = renderList(
      connectedDevices.map((device) =>
        renderListItem({
          label: device.name ?? device.address,
          className: "device-item",
          data: { address: device.address },
        })
      )
    );
    if (registerSelected && connectedDevices.some((d) => d.address === registerSelected)) {
      selectRegister(registerSelected);
      return;
    }
    const preferred = connectedDevices.find((d) => d.name.toUpperCase().includes("STONE"));
    if (preferred) {
      selectRegister(preferred.address);
      return;
    }
    if (connectedDevices[0]) {
      selectRegister(connectedDevices[0].address);
    }
  }

  function renderRegisteredList() {
    if (!registeredList) return;
    const pairedDevices = getRegisteredDevices();
    if (pairedDevices.length === 0) {
      registeredSelected = "";
      registeredList.innerHTML = renderList([
        renderListItem({
          label: "등록된 기기가 없습니다.",
          value: "",
          className: "device-item-empty",
        }),
      ]);
      return;
    }
    const options = pairedDevices.map((paired) => {
      const device = devices.find((d) => d.address === paired.address);
      const name = device?.name ?? paired.name ?? paired.address;
      return { address: paired.address, label: name };
    });
    registeredList.innerHTML = renderList(
      options.map((opt) =>
        renderListItem({
          label: opt.label,
          className: "device-item",
          data: { address: opt.address },
        })
      )
    );
    if (registeredSelected && pairedDevices.some((d) => d.address === registeredSelected)) {
      selectRegistered(registeredSelected);
      return;
    }
    if (pairedDevices[0]) {
      selectRegistered(pairedDevices[0].address);
    }
  }

  function renderActiveList() {
    if (!activeList) return;
    const activeAddress = deps.getConnectedAddress();
    if (!activeAddress) {
      activeList.innerHTML = renderList([
        renderListItem({
          label: "연결된 기기가 없습니다.",
          value: "",
          className: "device-item-empty",
        }),
      ]);
      return;
    }
    const name = getDeviceLabel(activeAddress);
    activeList.innerHTML = renderList([
      renderListItem({
        label: name,
        className: "device-item is-selected",
        data: { address: activeAddress },
      }),
    ]);
  }

  function upsertPairedDevice(address: string) {
    if (!address) return;
    const latestName = devices.find((d) => d.address === address)?.name ?? address;
    upsertRegisteredDevice(address, latestName);
    renderRegisteredList();
  }

  function removePairedDevice(address: string) {
    if (!address) return;
    removeRegisteredDevice(address);
    renderRegisteredList();
  }

  async function refreshDevices() {
    devices = (await invoke<DeviceInfo[]>("list_devices")) ?? [];
    renderRegisterList();
    renderRegisteredList();
    renderActiveList();
  }

  async function syncBackendConnection() {
    try {
      const info = await invoke<ConnectionInfo>("get_connection_info");
      if (info.rfcomm && info.address) {
        deps.setConnected(info.address);
        upsertPairedDevice(info.address);
        renderActiveList();
      } else if (deps.getConnectionState() === "connected") {
        deps.setDisconnected();
        renderActiveList();
      }
    } catch (err) {
      deps.logLine(String(err), "SYS");
    }
  }

  async function connectAddress(address: string) {
    if (!address) {
      deps.logLine("Select a device first", "SYS");
      return;
    }
    const state = deps.getConnectionState();
    if (state === "connecting" || state === "disconnecting") {
      deps.logLine("Connect already in progress", "SYS");
      return;
    }
    if (state === "connected" && deps.getConnectedAddress() === address) {
      deps.logLine("Already connected", "SYS");
      return;
    }
    try {
      deps.setConnectionState("connecting", address);
      await invoke("connect_device_async", { address });
    } catch (err) {
      deps.logLine(String(err), "SYS");
      deps.setConnectionState("idle", null);
    }
  }

  async function registerDevice() {
    const address = registerSelected;
    if (!address) {
      deps.logLine("Select a device to register", "SYS");
      return;
    }
    const state = deps.getConnectionState();
    if (state === "connecting" || state === "disconnecting") {
      deps.logLine("Connect already in progress", "SYS");
      return;
    }
    if (state === "connected" && deps.getConnectedAddress() === address) {
      upsertPairedDevice(address);
      deps.logLine(`Registered ${getDeviceLabel(address)}`, "SYS");
      return;
    }
    try {
      registerPending = address;
      await connectAddress(address);
    } catch (err) {
      registerPending = null;
      deps.logLine(String(err), "SYS");
      deps.setConnectionState("idle", null);
    }
  }

  async function disconnect() {
    try {
      deps.setConnectionState("disconnecting", deps.getConnectedAddress());
      await invoke("disconnect_device");
      deps.setDisconnected();
      deps.logLine("Disconnected", "SYS");
    } catch (err) {
      deps.logLine(String(err), "SYS");
      deps.setConnectionState("idle", deps.getConnectedAddress());
    }
  }

  function handleConnectResult(result: ConnectResultEvent) {
    const device = devices.find((d) => d.address === result.address);
    if (result.ok) {
      deps.setConnected(result.address);
      upsertPairedDevice(result.address);
      renderActiveList();
      if (registerPending === result.address) {
        deps.logLine(`Registered ${device?.name ?? result.address}`, "SYS");
        registerPending = null;
      }
      deps.logLine(`Connected to ${device?.name ?? result.address}`, "SYS");
    } else {
      if (registerPending === result.address) {
        deps.logLine(result.error ?? "Register failed", "SYS");
        registerPending = null;
      }
      if (deps.getConnectedAddress() === result.address) {
        deps.setDisconnected();
      } else {
        deps.setConnectionState("idle", deps.getConnectedAddress());
      }
      renderActiveList();
      deps.logLine(result.error ?? "Connect failed", "SYS");
    }
  }

  function handleDeviceEvent(payload: DeviceStateEvent) {
    const { address, connected } = payload;
    const target = devices.find((d) => d.address === address);
    if (target) {
      target.connected = connected;
      renderRegisterList();
      renderRegisteredList();
    } else {
      void refreshDevices().catch((err) => deps.logLine(String(err), "SYS"));
    }
    if (deps.getConnectedAddress() === address && !connected) {
      if (deps.getConnectionState() === "connecting") {
        return;
      }
      deps.setDisconnected();
    }
    renderActiveList();
  }

  registerList?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const item = target.closest(".device-item") as HTMLElement | null;
    if (!item) return;
    const address = item.dataset.address;
    if (!address) return;
    selectRegister(address);
  });

  registeredList?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const item = target.closest(".device-item") as HTMLElement | null;
    if (!item) return;
    const address = item.dataset.address;
    if (!address) return;
    selectRegistered(address);
  });

  registerButton?.addEventListener("click", () => {
    void registerDevice();
  });

  return {
    connectAddress,
    disconnect,
    refreshDevices,
    syncBackendConnection,
    handleConnectResult,
    handleDeviceEvent,
    getDeviceLabel,
  };
}
