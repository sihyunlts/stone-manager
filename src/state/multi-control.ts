import { getDeviceConnection } from "./connection";
import {
  getRegisteredDevices,
  getSelectedSingleDeviceAddress,
  isSelectedTargetMulti,
  setSelectedSingleDeviceAddress,
} from "./registry";

const MULTI_CONTROL_MENU_ENABLED_KEY = "stone.multi_control_menu_enabled_v1";

let multiControlMenuEnabled = loadMultiControlMenuEnabled();

function loadMultiControlMenuEnabled() {
  try {
    return window.localStorage.getItem(MULTI_CONTROL_MENU_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveMultiControlMenuEnabled(next: boolean) {
  try {
    window.localStorage.setItem(MULTI_CONTROL_MENU_ENABLED_KEY, next ? "1" : "0");
  } catch {
  }
}

export function isMultiControlMenuEnabled() {
  return multiControlMenuEnabled;
}

export function setMultiControlMenuEnabled(enabled: boolean) {
  if (multiControlMenuEnabled === enabled) return;
  multiControlMenuEnabled = enabled;
  saveMultiControlMenuEnabled(enabled);
  if (!enabled && isSelectedTargetMulti()) {
    setSelectedSingleDeviceAddress(getRegisteredDevices()[0]?.address ?? null);
  }
}

export function getMultiControlTargetAddresses() {
  const targets: string[] = [];
  const seen = new Set<string>();

  for (const device of getRegisteredDevices()) {
    const normalized = device.address.toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    const connection = getDeviceConnection(device.address);
    if (!connection || connection.state !== "connected" || !connection.rfcomm) continue;
    seen.add(normalized);
    targets.push(device.address);
  }

  return targets;
}

export function getControlTargetAddresses() {
  if (isSelectedTargetMulti()) {
    return getMultiControlTargetAddresses();
  }
  const address = getSelectedSingleDeviceAddress();
  return address ? [address] : [];
}
