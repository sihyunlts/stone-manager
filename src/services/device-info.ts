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
let devInfoFirmware: HTMLElement | null = null;
let devInfoMac: HTMLElement | null = null;
let devInfoRssi: HTMLElement | null = null;
let devInfoWheel: HTMLElement | null = null;
let infoName: HTMLElement | null = null;
let infoFirmware: HTMLElement | null = null;
let infoMac: HTMLElement | null = null;
let infoRssi: HTMLElement | null = null;
let infoWheel: HTMLElement | null = null;
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
    setDevInfo(devInfoFirmware, "--");
    setDevInfo(devInfoMac, "--");
    setDevInfo(devInfoRssi, "--");
    setDevInfo(devInfoWheel, "--");
    setDevInfo(infoName, "--");
    setDevInfo(infoFirmware, "--");
    setDevInfo(infoMac, "--");
    setDevInfo(infoRssi, "--");
    setDevInfo(infoWheel, "--");
    return;
  }

  const info = stateByAddress.get(address.toLowerCase());
  setDevInfo(devInfoName, info?.name ?? "--");
  setDevInfo(infoName, info?.name ?? "--");
  setDevInfo(devInfoFirmware, info?.firmware ?? "--");
  setDevInfo(infoFirmware, info?.firmware ?? "--");
  setDevInfo(devInfoMac, info?.mac ?? "--");
  setDevInfo(infoMac, info?.mac ?? "--");
  setDevInfo(devInfoRssi, info?.rssi === null || info?.rssi === undefined ? "--" : `${info.rssi} dBm`);
  setDevInfo(infoRssi, info?.rssi === null || info?.rssi === undefined ? "--" : `${info.rssi} dBm`);
  setDevInfo(devInfoWheel, info?.wheel === null || info?.wheel === undefined ? "--" : String(info.wheel));
  setDevInfo(infoWheel, info?.wheel === null || info?.wheel === undefined ? "--" : String(info.wheel));
}

export function initDeviceInfo() {
  devInfoName = document.querySelector<HTMLElement>("#devInfoName");
  devInfoFirmware = document.querySelector<HTMLElement>("#devInfoFirmware");
  devInfoMac = document.querySelector<HTMLElement>("#devInfoMac");
  devInfoRssi = document.querySelector<HTMLElement>("#devInfoRssi");
  devInfoWheel = document.querySelector<HTMLElement>("#devInfoWheel");
  infoName = document.querySelector<HTMLElement>("#settingsName");
  infoFirmware = document.querySelector<HTMLElement>("#settingsFirmware");
  infoMac = document.querySelector<HTMLElement>("#settingsMac");
  infoRssi = document.querySelector<HTMLElement>("#settingsRssi");
  infoWheel = document.querySelector<HTMLElement>("#settingsWheel");
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
