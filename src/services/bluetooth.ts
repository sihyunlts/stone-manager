import { invoke } from "@tauri-apps/api/core";
import type { ConnectionState } from "../state/connection";
import {
  getRegisteredDevices,
  upsertRegisteredDevice as upsertRegisteredDeviceFromStore,
} from "../state/registry";

export type DeviceInfo = {
  name: string;
  address: string;
  connected: boolean;
  alias?: string | null;
  raw_name?: string | null;
};

export type { ConnectionState } from "../state/connection";

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
  let devices: DeviceInfo[] = [];
  let registerPending: string | null = null;

  function getDeviceLabel(address: string) {
    const device = devices.find((d) => d.address === address);
    if (device?.name) return device.name;
    const paired = getRegisteredDevices().find((d) => d.address === address);
    return paired?.name ?? address;
  }

  function registerDevice(address: string) {
    if (!address) return;
    const latestName = devices.find((d) => d.address === address)?.name ?? address;
    upsertRegisteredDeviceFromStore(address, latestName);
  }

  async function refreshDevices() {
    devices = (await invoke<DeviceInfo[]>("list_devices")) ?? [];
    return devices;
  }

  async function syncBackendConnection() {
    try {
      const info = await invoke<ConnectionInfo>("get_connection_info");
      if (info.rfcomm && info.address) {
        deps.setConnected(info.address);
        registerDevice(info.address);
      } else if (deps.getConnectionState() === "connected") {
        deps.setDisconnected();
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

  async function addDevice(address: string) {
    if (!address) {
      deps.logLine("Select a device to pair", "SYS");
      return;
    }
    const state = deps.getConnectionState();
    if (state === "connecting" || state === "disconnecting") {
      deps.logLine("Connect already in progress", "SYS");
      return;
    }
    if (state === "connected" && deps.getConnectedAddress() === address) {
      registerDevice(address);
      deps.logLine(`Device paired: ${getDeviceLabel(address)}`, "SYS");
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
      registerDevice(result.address);
      if (registerPending === result.address) {
        deps.logLine(`Device paired: ${device?.name ?? result.address}`, "SYS");
        registerPending = null;
      }
      deps.logLine(`Connected to ${device?.name ?? result.address}`, "SYS");
    } else {
      if (registerPending === result.address) {
        deps.logLine(result.error ?? "Pair failed", "SYS");
        registerPending = null;
      }
      if (deps.getConnectedAddress() === result.address) {
        deps.setDisconnected();
      } else {
        deps.setConnectionState("idle", deps.getConnectedAddress());
      }
      deps.logLine(result.error ?? "Connect failed", "SYS");
    }
  }

  function handleDeviceEvent(payload: DeviceStateEvent) {
    const { address, connected } = payload;
    const target = devices.find((d) => d.address === address);
    if (target) {
      target.connected = connected;
    } else {
      void refreshDevices().catch((err) => deps.logLine(String(err), "SYS"));
    }
    if (deps.getConnectedAddress() === address && !connected) {
      if (deps.getConnectionState() === "connecting") {
        return;
      }
      deps.setDisconnected();
    }
  }

  return {
    getDevices: () => devices,
    connectAddress,
    addDevice,
    disconnect,
    refreshDevices,
    syncBackendConnection,
    handleConnectResult,
    handleDeviceEvent,
    getDeviceLabel,
  };
}
