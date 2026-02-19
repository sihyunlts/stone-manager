export type DeviceData = {
  batteryStep: number | null;
  batteryLevel: number | null;
  dcState: number | null;
  volume: number | null;
  lampOn: boolean;
  lampBrightness: number | null;
  lampType: number;
  lampHue: number;
  lampLastNonZero: number;
};

const DEFAULT_DATA: DeviceData = {
  batteryStep: null,
  batteryLevel: null,
  dcState: null,
  volume: null,
  lampOn: false,
  lampBrightness: null,
  lampType: 1,
  lampHue: 0,
  lampLastNonZero: 50,
};

const deviceData = new Map<string, DeviceData>();

function cloneDefault() {
  return { ...DEFAULT_DATA };
}

export function getDeviceData(address: string) {
  const existing = deviceData.get(address);
  if (existing) return existing;
  const next = cloneDefault();
  deviceData.set(address, next);
  return next;
}

export function updateDeviceData(address: string, patch: Partial<DeviceData>) {
  const next = { ...getDeviceData(address), ...patch };
  deviceData.set(address, next);
  return next;
}

export function getDefaultDeviceData() {
  return cloneDefault();
}
