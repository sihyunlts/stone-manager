import { invoke } from "@tauri-apps/api/core";
import {
  getDeviceConnection,
  replaceConnectionInfos,
  setDeviceConnected,
  setDeviceConnectionState,
  setDeviceDisconnected,
  setDeviceLinkState,
} from "../state/connection";
import {
  getActiveDeviceAddress,
  getRegisteredDevices,
  setActiveDeviceAddress,
  upsertRegisteredDevice as upsertRegisteredDeviceFromStore,
} from "../state/registry";

export type DeviceInfo = {
  name: string;
  address: string;
  connected: boolean;
  has_gaia: boolean;
  paired: boolean;
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
  address: string;
  link: boolean;
  rfcomm: boolean;
};

type ConnectQueueReason = "manual" | "startup" | "pair";

type ConnectQueueItem = {
  address: string;
  reason: ConnectQueueReason;
  activateOnSuccess: boolean;
  quiet: boolean;
};

type ConnectControllerDeps = {
  logLine: (line: string, tone?: "IN" | "OUT" | "SYS") => void;
  onAutoPaired?: (name: string, address: string) => void;
};

type AddDeviceOptions = {
  suppressAutoPairedToast?: boolean;
};

function normalizeAddress(address: string) {
  return address.trim().toLowerCase();
}

function isSameAddress(a: string, b: string) {
  return normalizeAddress(a) === normalizeAddress(b);
}

export function initConnectController(deps: ConnectControllerDeps) {
  let devices: DeviceInfo[] = [];
  let registerPending: string | null = null;
  const suppressedAutoPairedToastAddresses = new Set<string>();
  let eventRefreshInFlight = false;
  let eventRefreshPending = false;
  const connectQueue: ConnectQueueItem[] = [];
  let connectInFlight: ConnectQueueItem | null = null;

  function getDeviceLabel(address: string) {
    const device = devices.find((d) => isSameAddress(d.address, address));
    if (device?.name) return device.name;
    const paired = getRegisteredDevices().find((d) => isSameAddress(d.address, address));
    return paired?.name ?? address;
  }

  function registerDevice(address: string, preferredName?: string) {
    if (!address) return;
    const normalized = normalizeAddress(address);
    const alreadyRegistered = getRegisteredDevices().some((d) => isSameAddress(d.address, address));
    const latestName =
      preferredName ??
      devices.find((d) => isSameAddress(d.address, address))?.name ??
      address;
    upsertRegisteredDeviceFromStore(address, latestName);
    if (!alreadyRegistered) {
      const suppressToast = suppressedAutoPairedToastAddresses.delete(normalized);
      if (!suppressToast) {
        deps.onAutoPaired?.(latestName, address);
      }
    }
  }

  async function refreshDevices() {
    devices = (await invoke<DeviceInfo[]>("list_devices")) ?? [];
    return devices;
  }

  async function refreshDevicesFromEvent() {
    if (eventRefreshInFlight) {
      eventRefreshPending = true;
      return devices;
    }
    eventRefreshInFlight = true;
    try {
      return await refreshDevices();
    } finally {
      eventRefreshInFlight = false;
      if (eventRefreshPending) {
        eventRefreshPending = false;
        void refreshDevicesFromEvent().catch((err) => deps.logLine(String(err), "SYS"));
      }
    }
  }

  function dequeueNextConnect() {
    if (connectInFlight || connectQueue.length === 0) return;

    const next = connectQueue.shift();
    if (!next) return;

    connectInFlight = next;
    setDeviceConnectionState(next.address, "connecting", { lastError: null });

    invoke("connect_device_async", { address: next.address })
      .catch((err) => {
        const message = String(err);
        setDeviceDisconnected(next.address, { lastError: message });
        suppressedAutoPairedToastAddresses.delete(normalizeAddress(next.address));
        if (registerPending && isSameAddress(registerPending, next.address)) {
          deps.logLine(message, "SYS");
          registerPending = null;
        } else if (!next.quiet) {
          deps.logLine(message, "SYS");
        }
        connectInFlight = null;
        dequeueNextConnect();
      });
  }

  function enqueueConnect(item: ConnectQueueItem) {
    const address = item.address;
    const current = getDeviceConnection(address);

    if (current?.rfcomm && current.state === "connected") {
      if (item.reason === "pair") {
        registerDevice(address);
        deps.logLine(`Device paired: ${getDeviceLabel(address)}`, "SYS");
      } else if (!item.quiet) {
        deps.logLine("Already connected", "SYS");
      }
      if (item.activateOnSuccess) {
        setActiveDeviceAddress(address);
      }
      return;
    }

    if (connectInFlight && isSameAddress(connectInFlight.address, address)) {
      if (!item.quiet) deps.logLine("Connect already in progress", "SYS");
      return;
    }
    if (connectQueue.some((queued) => isSameAddress(queued.address, address))) {
      if (!item.quiet) deps.logLine("Connect already queued", "SYS");
      return;
    }

    connectQueue.push(item);
    dequeueNextConnect();
  }

  function handleConnectResult(result: ConnectResultEvent) {
    const current = connectInFlight && isSameAddress(connectInFlight.address, result.address)
      ? connectInFlight
      : null;
    const cachedName = devices.find((d) => isSameAddress(d.address, result.address))?.name;

    if (result.ok) {
      setDeviceConnected(result.address);
      void refreshDevices().catch((err) => deps.logLine(String(err), "SYS"));

      const resolvedName =
        devices.find((d) => isSameAddress(d.address, result.address))?.name ??
        cachedName ??
        result.address;
      registerDevice(result.address, resolvedName);

      if (registerPending && isSameAddress(registerPending, result.address)) {
        deps.logLine(`Device paired: ${resolvedName}`, "SYS");
        registerPending = null;
      }

      if (current?.activateOnSuccess) {
        setActiveDeviceAddress(result.address);
      } else if (!getActiveDeviceAddress()) {
        setActiveDeviceAddress(result.address);
      }

      if (!current?.quiet) {
        deps.logLine(`Connected to ${resolvedName}`, "SYS");
      }
    } else {
      const message = result.error ?? "Connect failed";
      setDeviceDisconnected(result.address, { lastError: message });
      suppressedAutoPairedToastAddresses.delete(normalizeAddress(result.address));

      if (registerPending && isSameAddress(registerPending, result.address)) {
        deps.logLine(message, "SYS");
        registerPending = null;
      } else if (!current?.quiet) {
        deps.logLine(message, "SYS");
      }
    }

    if (current) {
      connectInFlight = null;
      dequeueNextConnect();
    }
  }

  async function syncBackendConnections() {
    try {
      const infos = await invoke<ConnectionInfo[]>("get_connection_infos");
      replaceConnectionInfos(infos ?? []);

      for (const info of infos ?? []) {
        if (!info.rfcomm) continue;
        registerDevice(info.address);
      }
      if (!getActiveDeviceAddress()) {
        const firstConnected = (infos ?? []).find((info) => info.rfcomm);
        if (firstConnected) {
          setActiveDeviceAddress(firstConnected.address);
        }
      }
    } catch (err) {
      deps.logLine(String(err), "SYS");
    }
  }

  async function autoRegisterConnectedGaiaDevices() {
    const latest = await refreshDevices();
    for (const device of latest) {
      if (!device.connected || !device.has_gaia) continue;
      const alreadyRegistered = getRegisteredDevices().some((d) => isSameAddress(d.address, device.address));
      registerDevice(device.address);
      if (!alreadyRegistered) {
        deps.logLine(`Device paired: ${device.name ?? device.address}`, "SYS");
      }
    }
  }

  async function autoConnectRegisteredDevices() {
    const registered = getRegisteredDevices();
    if (registered.length === 0) return;

    const active = getActiveDeviceAddress();
    const ordered = [
      ...(active ? [active] : []),
      ...registered.map((d) => d.address).filter((address) => !active || !isSameAddress(address, active)),
    ];

    const seen = new Set<string>();
    for (const address of ordered) {
      const key = normalizeAddress(address);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const conn = getDeviceConnection(address);
      if (conn?.rfcomm && conn.state === "connected") continue;
      enqueueConnect({
        address,
        reason: "startup",
        activateOnSuccess: false,
        quiet: true,
      });
    }
  }

  async function connectAddress(address: string) {
    if (!address) {
      deps.logLine("Select a device first", "SYS");
      return;
    }

    const current = getDeviceConnection(address);
    if (current?.state === "disconnecting") {
      deps.logLine("Disconnect in progress", "SYS");
      return;
    }

    enqueueConnect({
      address,
      reason: "manual",
      activateOnSuccess: true,
      quiet: false,
    });
  }

  async function addDevice(address: string, options?: AddDeviceOptions) {
    if (!address) {
      deps.logLine("Select a device to pair", "SYS");
      return;
    }
    if (options?.suppressAutoPairedToast) {
      suppressedAutoPairedToastAddresses.add(normalizeAddress(address));
    } else {
      suppressedAutoPairedToastAddresses.delete(normalizeAddress(address));
    }
    registerPending = address;
    enqueueConnect({
      address,
      reason: "pair",
      activateOnSuccess: true,
      quiet: false,
    });
  }

  async function disconnectAddress(address: string) {
    if (!address) return;
    setDeviceConnectionState(address, "disconnecting");
    try {
      await invoke("disconnect_device", { address });
      setDeviceDisconnected(address, { lastError: null });
      deps.logLine("Disconnected", "SYS");
    } catch (err) {
      const message = String(err);
      deps.logLine(message, "SYS");
      try {
        const infos = await invoke<ConnectionInfo[]>("get_connection_infos");
        replaceConnectionInfos(infos ?? []);
        const stillConnected = (infos ?? []).some(
          (info) => isSameAddress(info.address, address) && info.rfcomm
        );
        if (stillConnected) {
          setDeviceConnected(address);
          deps.logLine("Disconnect failed (still connected)", "SYS");
        } else {
          setDeviceDisconnected(address, { lastError: message });
        }
      } catch (infoErr) {
        deps.logLine(String(infoErr), "SYS");
        setDeviceDisconnected(address, { lastError: message });
      }
    }
  }

  function handleDeviceEvent(payload: DeviceStateEvent) {
    const { address, connected } = payload;
    const target = devices.find((d) => isSameAddress(d.address, address));
    if (target) target.connected = connected;

    if (connected) {
      setDeviceLinkState(address, true);
    } else {
      setDeviceDisconnected(address, { link: false, rfcomm: false, lastError: null });
    }

    if (!target) {
      void refreshDevicesFromEvent().catch((err) => deps.logLine(String(err), "SYS"));
    }

    if (connected) {
      void (async () => {
        try {
          const latest = await refreshDevicesFromEvent();
          const found = latest.find((d) => isSameAddress(d.address, address));
          if (!found || !found.connected || !found.has_gaia) {
            return;
          }
          const alreadyRegistered = getRegisteredDevices().some((d) => isSameAddress(d.address, address));
          registerDevice(address);
          if (!alreadyRegistered) {
            deps.logLine(`Device paired: ${found.name ?? address}`, "SYS");
          }
        } catch (err) {
          deps.logLine(String(err), "SYS");
        }
      })();
    }
  }

  return {
    getDevices: () => devices,
    connectAddress,
    addDevice,
    disconnectAddress,
    refreshDevices,
    autoRegisterConnectedGaiaDevices,
    autoConnectRegisteredDevices,
    syncBackendConnections,
    handleConnectResult,
    handleDeviceEvent,
    getDeviceLabel,
  };
}
