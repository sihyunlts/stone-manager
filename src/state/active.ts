import {
  getRegisteredDevices,
  getSelectedSingleDeviceAddress,
} from "./registry";
import { getControlTargetAddresses } from "./multi-control";
import {
  getDeviceData,
  getDefaultDeviceData,
  updateDeviceData,
  type DeviceData,
} from "./telemetry";
import { getDeviceConnection } from "./connection";

function getSelectionAnchorAddress() {
  return getSelectedSingleDeviceAddress()
    ?? getControlTargetAddresses()[0]
    ?? getRegisteredDevices()[0]?.address
    ?? null;
}

export function getSelectionAnchorDeviceData() {
  const address = getSelectionAnchorAddress();
  if (!address) return getDefaultDeviceData();
  return getDeviceData(address);
}

export function updateSelectionAnchorDeviceData(patch: Partial<DeviceData>) {
  const address = getSelectionAnchorAddress();
  if (!address) return null;
  return updateDeviceData(address, patch);
}

export function isSelectedDeviceConnected() {
  const address = getSelectedSingleDeviceAddress();
  if (!address) return false;
  const conn = getDeviceConnection(address);
  return !!conn && conn.state === "connected" && conn.rfcomm;
}

export function getSelectedDeviceLabel() {
  const address = getSelectedSingleDeviceAddress();
  if (!address) return null;
  const registered = getRegisteredDevices().find(
    (device) => device.address === address
  );
  return registered?.name ?? address;
}
