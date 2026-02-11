import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { logLine, toHex } from "../utils/formatter";

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
}

function setDevInfo(target: HTMLElement | null, value: string) {
  if (target) target.textContent = value;
}

async function requestDeviceInfo(commandId: number) {
  try {
    await invoke("send_gaia_command", { vendorId: 0x5054, commandId, payload: [] });
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

export function handleDeviceInfoPacket(command: number, dataPayload: number[]) {
  if (command === 0x0451) {
    const name = new TextDecoder().decode(new Uint8Array(dataPayload)).trim();
    if (name) { setDevInfo(devInfoName, name); setDevInfo(infoName, name); }
  }
  if (command === 0x0452) {
    const firmware = new TextDecoder().decode(new Uint8Array(dataPayload)).trim();
    if (firmware) { setDevInfo(devInfoFirmware, firmware); setDevInfo(infoFirmware, firmware); }
  }
  if (command === 0x0453) {
    const mac = new TextDecoder().decode(new Uint8Array(dataPayload)).trim();
    if (mac) { setDevInfo(devInfoMac, mac); setDevInfo(infoMac, mac); }
  }
  if (command === 0x0454 && dataPayload.length >= 1) {
    const rssi = (dataPayload[0] & 0x80) ? dataPayload[0] - 256 : dataPayload[0];
    setDevInfo(devInfoRssi, `${rssi} dBm`); setDevInfo(infoRssi, `${rssi} dBm`);
  }
  if (command === 0x0457 && dataPayload.length >= 1) {
    setDevInfo(devInfoWheel, String(dataPayload[0])); setDevInfo(infoWheel, String(dataPayload[0]));
  }
}
