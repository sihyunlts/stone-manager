export type RegisteredDevice = {
  address: string;
  name: string;
};

export const MULTI_CONTROL_SELECT_VALUE = "__multi_control__";

export type SelectedTarget =
  | { kind: "single"; address: string }
  | { kind: "multi" }
  | null;

const STORAGE_KEY = "stone_paired_devices";

let devices: RegisteredDevice[] = loadDevices();
let selectedTarget: SelectedTarget = devices[0]?.address
  ? { kind: "single", address: devices[0].address }
  : null;
const listeners = new Set<(list: RegisteredDevice[]) => void>();
const selectedListeners = new Set<(target: SelectedTarget) => void>();

function loadDevices(): RegisteredDevice[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.address === "string");
  } catch {
    return [];
  }
}

function persistDevices(next: RegisteredDevice[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

function normalizeAddress(address: string | null | undefined) {
  return address?.trim().toLowerCase() ?? "";
}

function resolveRegisteredAddress(address: string | null | undefined) {
  const normalized = normalizeAddress(address);
  if (!normalized) return null;
  return devices.find((device) => normalizeAddress(device.address) === normalized)?.address ?? null;
}

function sameSelectedTarget(a: SelectedTarget, b: SelectedTarget) {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "multi" && b.kind === "multi") return true;
  if (a.kind === "single" && b.kind === "single") {
    return normalizeAddress(a.address) === normalizeAddress(b.address);
  }
  return false;
}

function getDefaultRegisteredDeviceAddress() {
  return devices[0]?.address ?? null;
}

function coerceSelectedTarget(next: SelectedTarget): SelectedTarget {
  if (!next) return null;
  if (next.kind === "multi") {
    return devices.length > 0 ? next : null;
  }
  const address = resolveRegisteredAddress(next.address);
  if (!address) {
    const fallback = getDefaultRegisteredDeviceAddress();
    return fallback ? { kind: "single", address: fallback } : null;
  }
  return { kind: "single", address };
}

function notify() {
  listeners.forEach((listener) => listener(devices));
}

function notifySelected() {
  selectedListeners.forEach((listener) => listener(selectedTarget));
}

export function getRegisteredDevices() {
  return devices;
}

export function subscribeRegisteredDevices(listener: (list: RegisteredDevice[]) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function subscribeSelectedTarget(listener: (target: SelectedTarget) => void) {
  selectedListeners.add(listener);
  return () => selectedListeners.delete(listener);
}

export function upsertRegisteredDevice(address: string, name: string) {
  const existing = devices.findIndex((d) => normalizeAddress(d.address) === normalizeAddress(address));
  if (existing >= 0) {
    devices[existing] = { address: devices[existing].address, name };
  } else {
    devices = [{ address, name }, ...devices];
  }

  const fallbackAddress = getDefaultRegisteredDeviceAddress()!;
  const nextSelected = coerceSelectedTarget(
    selectedTarget ?? { kind: "single", address: fallbackAddress }
  );
  const selectedChanged = !sameSelectedTarget(selectedTarget, nextSelected);
  selectedTarget = nextSelected;

  persistDevices(devices);
  notify();
  if (selectedChanged) notifySelected();
}

export function removeRegisteredDevice(address: string) {
  const normalized = normalizeAddress(address);
  devices = devices.filter((d) => normalizeAddress(d.address) !== normalized);

  const nextSelected = coerceSelectedTarget(selectedTarget);
  const selectedChanged = !sameSelectedTarget(selectedTarget, nextSelected);
  selectedTarget = nextSelected;

  persistDevices(devices);
  notify();
  if (selectedChanged) notifySelected();
}

export function isSelectedTargetMulti() {
  return selectedTarget?.kind === "multi";
}

export function getSelectedSingleDeviceAddress() {
  return selectedTarget?.kind === "single" ? selectedTarget.address : null;
}

export function setSelectedSingleDeviceAddress(address: string | null) {
  const resolved = resolveRegisteredAddress(address);
  const nextSelected = resolved ? { kind: "single" as const, address: resolved } : null;
  if (!sameSelectedTarget(selectedTarget, nextSelected)) {
    selectedTarget = nextSelected;
    notifySelected();
  }
}

export function setSelectedTargetMulti() {
  const nextSelected = coerceSelectedTarget({ kind: "multi" });
  if (sameSelectedTarget(selectedTarget, nextSelected)) return;
  selectedTarget = nextSelected;
  notifySelected();
}
