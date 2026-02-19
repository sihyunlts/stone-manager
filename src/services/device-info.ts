import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { getActiveDeviceAddress } from "../state/registry";
import { logLine, toHex } from "../utils/formatter";

type DeviceInfoState = {
  name: string | null;
  firmware: string | null;
  mac: string | null;
  rssi: number | null;
  wheel: number | null;
};

let devInfoName: HTMLElement | null = null;
let devInfoWheel: HTMLElement | null = null;
let settingsFirmware: HTMLElement | null = null;
let settingsMac: HTMLElement | null = null;
let settingsRssi: HTMLElement | null = null;
let settingsAppVersion: HTMLElement | null = null;

const stateByAddress = new Map<string, DeviceInfoState>();

function getOrCreateState(address: string) {
  const key = address.toLowerCase();
  const existing = stateByAddress.get(key);
  if (existing) return existing;
  const next: DeviceInfoState = {
    name: null,
    firmware: null,
    mac: null,
    rssi: null,
    wheel: null,
  };
  stateByAddress.set(key, next);
  return next;
}

function setDevInfo(target: HTMLElement | null, value: string) {
  if (target) target.textContent = value;
}

function renderDeviceInfo(address: string | null) {
  if (!address) {
    setDevInfo(devInfoName, "--");
    setDevInfo(devInfoWheel, "--");
    setDevInfo(settingsFirmware, "--");
    setDevInfo(settingsMac, "--");
    setDevInfo(settingsRssi, "--");
    return;
  }

  const info = stateByAddress.get(address.toLowerCase());
  setDevInfo(devInfoName, info?.name ?? "--");
  setDevInfo(devInfoWheel, info?.wheel === null || info?.wheel === undefined ? "--" : String(info.wheel));
  setDevInfo(settingsFirmware, info?.firmware ?? "--");
  setDevInfo(settingsMac, info?.mac ?? "--");
  setDevInfo(settingsRssi, info?.rssi === null || info?.rssi === undefined ? "--" : `${info.rssi} dBm`);
}

export function initDeviceInfo() {
  devInfoName = document.querySelector<HTMLElement>("#devInfoName");
  devInfoWheel = document.querySelector<HTMLElement>("#devInfoWheel");
  settingsFirmware = document.querySelector<HTMLElement>("#settingsFirmware");
  settingsMac = document.querySelector<HTMLElement>("#settingsMac");
  settingsRssi = document.querySelector<HTMLElement>("#settingsRssi");
  settingsAppVersion = document.querySelector<HTMLElement>("#settingsAppVersion");
  loadAppVersion().catch(() => {});
  updateDeviceInfoUI();
}

export function updateDeviceInfoUI() {
  renderDeviceInfo(getActiveDeviceAddress());
}

async function requestDeviceInfo(commandId: number) {
  const address = getActiveDeviceAddress();
  if (!address) return;
  try {
    await invoke("send_gaia_command", { address, vendorId: 0x5054, commandId, payload: [] });
    logLine(`Device info request (${toHex(0x5054, 4)} ${toHex(commandId, 4)})`, "OUT");
  } catch (err) {
    logLine(String(err), "SYS");
  }
}

export function requestStaticDeviceInfo() {
  requestDeviceInfo(0x0451).catch(() => {});
  requestDeviceInfo(0x0452).catch(() => {});
  requestDeviceInfo(0x0453).catch(() => {});
  requestDeviceInfo(0x0457).catch(() => {});
}

export function requestDynamicDeviceInfo() {
  requestDeviceInfo(0x0454).catch(() => {});
}

async function loadAppVersion() {
  if (!settingsAppVersion) return;
  try {
    const version = await getVersion();
    settingsAppVersion.textContent = version || "--";
  } catch {
    settingsAppVersion.textContent = "--";
  }
}

export function handleDeviceInfoPacket(address: string, command: number, dataPayload: number[]) {
  if (!address) return;
  const state = getOrCreateState(address);

  if (command === 0x0451) {
    const name = new TextDecoder().decode(new Uint8Array(dataPayload)).trim();
    if (name) state.name = name;
  }
  if (command === 0x0452) {
    const firmware = new TextDecoder().decode(new Uint8Array(dataPayload)).trim();
    if (firmware) state.firmware = firmware;
  }
  if (command === 0x0453) {
    const mac = new TextDecoder().decode(new Uint8Array(dataPayload)).trim();
    if (mac) state.mac = mac;
  }
  if (command === 0x0454 && dataPayload.length >= 1) {
    state.rssi = (dataPayload[0] & 0x80) ? dataPayload[0] - 256 : dataPayload[0];
  }
  if (command === 0x0457 && dataPayload.length >= 1) {
    state.wheel = dataPayload[0];
  }

  if (getActiveDeviceAddress()?.toLowerCase() === address.toLowerCase()) {
    renderDeviceInfo(address);
  }
}
