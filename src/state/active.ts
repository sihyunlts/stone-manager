import { getActiveDeviceAddress, getRegisteredDevices } from "./registry";
import {
  getDeviceData,
  getDefaultDeviceData,
  updateDeviceData,
  type DeviceData,
} from "./telemetry";
import { getDeviceConnection } from "./connection";

export function getActiveDeviceData() {
  const address = getActiveDeviceAddress();
  if (!address) return getDefaultDeviceData();
  return getDeviceData(address);
}

export function updateActiveDeviceData(patch: Partial<DeviceData>) {
  const address = getActiveDeviceAddress();
  if (!address) return null;
  return updateDeviceData(address, patch);
}

export function isActiveDeviceConnected() {
  const active = getActiveDeviceAddress();
  if (!active) return false;
  const conn = getDeviceConnection(active);
  return !!conn && conn.state === "connected" && conn.rfcomm;
}

export function getActiveDeviceLabel() {
  const address = getActiveDeviceAddress();
  if (!address) return null;
  const registered = getRegisteredDevices().find(
    (device) => device.address === address
  );
  return registered?.name ?? address;
}
