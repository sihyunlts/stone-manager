export type RegisteredDevice = {
  address: string;
  name: string;
};

const STORAGE_KEY = "stone_paired_devices";

let devices: RegisteredDevice[] = loadDevices();
let activeAddress: string | null = devices[0]?.address ?? null;
const listeners = new Set<(list: RegisteredDevice[]) => void>();
const activeListeners = new Set<(address: string | null) => void>();

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

function notify() {
  listeners.forEach((listener) => listener(devices));
}

function notifyActive() {
  activeListeners.forEach((listener) => listener(activeAddress));
}

export function getRegisteredDevices() {
  return devices;
}

export function subscribeRegisteredDevices(listener: (list: RegisteredDevice[]) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function subscribeActiveDevice(listener: (address: string | null) => void) {
  activeListeners.add(listener);
  return () => activeListeners.delete(listener);
}

export function upsertRegisteredDevice(address: string, name: string) {
  const existing = devices.findIndex((d) => d.address === address);
  if (existing >= 0) {
    devices[existing] = { address, name };
  } else {
    devices = [{ address, name }, ...devices];
  }
  if (!activeAddress) {
    activeAddress = address;
    notifyActive();
  }
  persistDevices(devices);
  notify();
}

export function removeRegisteredDevice(address: string) {
  devices = devices.filter((d) => d.address !== address);
  if (activeAddress === address) {
    activeAddress = devices[0]?.address ?? null;
    notifyActive();
  }
  persistDevices(devices);
  notify();
}

export function getActiveDeviceAddress() {
  return activeAddress;
}

export function setActiveDeviceAddress(address: string | null) {
  if (activeAddress === address) return;
  activeAddress = address;
  notifyActive();
}
