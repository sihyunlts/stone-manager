export type ConnectionState = "idle" | "connecting" | "connected" | "disconnecting";

export type DeviceConnectionState = {
  state: ConnectionState;
  link: boolean;
  rfcomm: boolean;
  lastError: string | null;
  updatedAt: number;
};

export type ConnectionSnapshot = Record<string, DeviceConnectionState>;

const listeners = new Set<(next: ConnectionSnapshot) => void>();
let snapshot: ConnectionSnapshot = {};

function now() {
  return Date.now();
}

function normalizeAddress(address: string) {
  return address.trim().toLowerCase();
}

function defaultState(): DeviceConnectionState {
  return {
    state: "idle",
    link: false,
    rfcomm: false,
    lastError: null,
    updatedAt: now(),
  };
}

function upsert(address: string, patch: Partial<DeviceConnectionState>) {
  const key = normalizeAddress(address);
  if (!key) return null;
  const prev = snapshot[key] ?? defaultState();
  const next: DeviceConnectionState = {
    ...prev,
    ...patch,
    updatedAt: now(),
  };
  snapshot = {
    ...snapshot,
    [key]: next,
  };
  listeners.forEach((listener) => listener(snapshot));
  return next;
}

export function getConnectionSnapshot() {
  return snapshot;
}

export function getDeviceConnection(address: string | null | undefined) {
  if (!address) return null;
  const key = normalizeAddress(address);
  if (!key) return null;
  return snapshot[key] ?? null;
}

export function setDeviceConnectionState(
  address: string,
  state: ConnectionState,
  patch?: Partial<DeviceConnectionState>
) {
  return upsert(address, { ...(patch ?? {}), state });
}

export function setDeviceConnected(address: string) {
  return upsert(address, {
    state: "connected",
    link: true,
    rfcomm: true,
    lastError: null,
  });
}

export function setDeviceDisconnected(
  address: string,
  options?: { lastError?: string | null; link?: boolean; rfcomm?: boolean }
) {
  return upsert(address, {
    state: "idle",
    link: options?.link ?? false,
    rfcomm: options?.rfcomm ?? false,
    lastError: options?.lastError ?? null,
  });
}

export function setDeviceLinkState(address: string, connected: boolean) {
  const current = getDeviceConnection(address) ?? defaultState();
  if (!connected) {
    return upsert(address, {
      state: "idle",
      link: false,
      rfcomm: false,
    });
  }
  return upsert(address, {
    state: current.rfcomm ? "connected" : current.state,
    link: true,
  });
}

export function replaceConnectionInfos(
  infos: Array<{ address: string; link: boolean; rfcomm: boolean }>
) {
  const next: ConnectionSnapshot = { ...snapshot };
  const seen = new Set<string>();

  for (const info of infos) {
    const key = normalizeAddress(info.address ?? "");
    if (!key) continue;
    seen.add(key);
    const current = snapshot[key] ?? defaultState();
    next[key] = {
      state: info.rfcomm
        ? "connected"
        : current.state === "connecting"
          ? "connecting"
          : "idle",
      link: info.link,
      rfcomm: info.rfcomm,
      lastError: info.rfcomm ? null : current.lastError,
      updatedAt: now(),
    };
  }

  for (const key of Object.keys(next)) {
    if (seen.has(key)) continue;
    const current = next[key];
    if (current.state === "connecting" || current.state === "disconnecting") continue;
    next[key] = {
      ...current,
      state: "idle",
      link: false,
      rfcomm: false,
      updatedAt: now(),
    };
  }

  snapshot = next;
  listeners.forEach((listener) => listener(snapshot));
}

export function removeDeviceConnection(address: string) {
  const key = normalizeAddress(address);
  if (!key || !snapshot[key]) return;
  const next = { ...snapshot };
  delete next[key];
  snapshot = next;
  listeners.forEach((listener) => listener(snapshot));
}

export function subscribeConnection(listener: (next: ConnectionSnapshot) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
