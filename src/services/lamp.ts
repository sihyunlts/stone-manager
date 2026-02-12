import { invoke } from "@tauri-apps/api/core";
import { getActiveDeviceAddress } from "../state/registry";
import { getDeviceData, updateDeviceData } from "../state/telemetry";
import { getActiveDeviceData, updateActiveDeviceData, isActiveDeviceConnected } from "../state/active";
import { updateRangeFill } from "../components/range";
import { bindSelect } from "../components/select";
import { logLine } from "../utils/formatter";

let lampToggleEl: HTMLInputElement | null = null;
let lampBrightnessEl: HTMLInputElement | null = null;
let lampHueEl: HTMLInputElement | null = null;
let lampSettingsEl: HTMLElement | null = null;
let lampHueContainerEl: HTMLElement | null = null;
let lampTypeSelect: ReturnType<typeof bindSelect> | null = null;
let lampDebounce: ReturnType<typeof setTimeout> | null = null;

export function initLamp() {
  lampToggleEl = document.querySelector<HTMLInputElement>("#lampToggle");
  lampBrightnessEl = document.querySelector<HTMLInputElement>("#lampBrightness");
  lampHueEl = document.querySelector<HTMLInputElement>("#lampHue");
  lampSettingsEl = document.querySelector<HTMLElement>("#lampSettings");
  lampHueContainerEl = document.querySelector<HTMLElement>("#lampHueContainer");

  lampTypeSelect = bindSelect("lampType", (value) => {
    const next = Number(value);
    const data = updateActiveDeviceData({ lampType: next });
    if (!data || !data.lampOn) return;
    setLampType(next).catch((err) => logLine(String(err), "SYS"));
    if (next === 1) {
      setLampColor(data.lampHue).catch((err) => logLine(String(err), "SYS"));
    }
    updateLampUI();
  });

  lampToggleEl?.addEventListener("change", () => {
    if (!lampToggleEl) return;
    const currentData = getActiveDeviceData();
    const current = currentData.lampBrightness ?? 0;
    const nextValue = lampToggleEl.checked
      ? current > 0 ? current : currentData.lampLastNonZero
      : 0;
    const updated = updateActiveDeviceData({
      lampBrightness: nextValue,
      lampOn: lampToggleEl.checked,
      lampLastNonZero: nextValue > 0 ? nextValue : currentData.lampLastNonZero,
    });
    if (nextValue > 0) updateActiveDeviceData({ lampLastNonZero: nextValue });
    updateLampUI();
    if (!updated || !isActiveDeviceConnected()) return;
    if (updated.lampOn) {
      runLamp(nextValue, updated.lampType, updated.lampHue).catch((err) => logLine(String(err), "SYS"));
    } else {
      stopLamp().catch((err) => logLine(String(err), "SYS"));
    }
  });

  lampBrightnessEl?.addEventListener("input", () => {
    if (!lampBrightnessEl) return;
    const value = Number(lampBrightnessEl.value);
    const updated = updateActiveDeviceData({
      lampBrightness: value,
      lampLastNonZero: value > 0 ? value : getActiveDeviceData().lampLastNonZero,
    });
    if (value > 0) updateActiveDeviceData({ lampLastNonZero: value });
    updateLampUI();
    if (lampDebounce) clearTimeout(lampDebounce);
    lampDebounce = setTimeout(() => {
      if (!updated || !updated.lampOn || !isActiveDeviceConnected()) return;
      setLampBrightness(value).catch((err) => logLine(String(err), "SYS"));
    }, 150);
    updateRangeFill(lampBrightnessEl);
  });

  lampHueEl?.addEventListener("input", () => {
    if (!lampHueEl) return;
    const nextHue = Number(lampHueEl.value);
    const updated = updateActiveDeviceData({ lampHue: nextHue });
    updateRangeFill(lampHueEl);
    if (!updated || !updated.lampOn || !isActiveDeviceConnected()) return;
    if (updated.lampType === 1) {
      setLampColor(updated.lampHue).catch((err) => logLine(String(err), "SYS"));
    }
  });
}

export function updateLampUI() {
  if (!lampBrightnessEl || !lampToggleEl || !lampHueEl) return;
  const data = getActiveDeviceData();
  lampBrightnessEl.value = data.lampBrightness === null ? "0" : String(data.lampBrightness);
  updateRangeFill(lampBrightnessEl);
  lampToggleEl.checked = data.lampOn;
  lampTypeSelect?.setValue(data.lampType);
  lampHueEl.value = String(data.lampHue);
  updateRangeFill(lampHueEl);
  if (lampSettingsEl) {
    lampSettingsEl.classList.toggle("is-hidden", !data.lampOn);
  }
  if (lampHueContainerEl) {
    const isVisible = data.lampType === 1;
    lampHueContainerEl.style.display = isVisible ? "" : "none";
    if (lampHueContainerEl.parentElement) {
      lampHueContainerEl.parentElement.style.display = isVisible ? "" : "none";
    }
  }
}

export function sliderToRgb(value: number) {
  const v = Math.max(0, Math.min(360, value));
  const whiteBand = 20;
  if (v <= whiteBand) {
    const t = v / whiteBand;
    return [255, Math.round(255 - t * 13), Math.round(255 - t * 255)];
  }
  const h = 60 + ((v - whiteBand) / (360 - whiteBand)) * 300;
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(1, Math.min(k, 4 - k)))));
  };
  return [f(5), f(3), f(1)];
}

export function rgbToSlider(r: number, g: number, b: number) {
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
  const d = max - min;
  if (d < 0.05 && max > 0.9) return 0;
  let h = 0;
  if (d !== 0) {
    if (max === rf) h = (gf - bf) / d + (gf < bf ? 6 : 0);
    else if (max === gf) h = (bf - rf) / d + 2;
    else h = (rf - gf) / d + 4;
    h *= 60;
  }
  if (h < 60) return 20;
  return Math.round(20 + ((h - 60) / 300) * 340);
}

export async function requestLampState() {
  const address = getActiveDeviceAddress();
  if (!address) return;
  try {
    await invoke("send_gaia_command", { address, vendorId: 0x5054, commandId: 0x0411, payload: [] });
    logLine("Lamp request (5054 0411)", "OUT");
  } catch (err) {
    logLine(String(err), "SYS");
  }
}

async function setLampBrightness(value: number) {
  const address = getActiveDeviceAddress();
  if (!address) return;
  const rounded = Math.round(value);
  await invoke("send_gaia_command", { address, vendorId: 0x5054, commandId: 0x0202, payload: [rounded] });
}

async function setLampType(value: number) {
  const address = getActiveDeviceAddress();
  if (!address) return;
  await invoke("send_gaia_command", { address, vendorId: 0x5054, commandId: 0x0203, payload: [value] });
}

async function setLampColor(hue: number) {
  const address = getActiveDeviceAddress();
  if (!address) return;
  const [r, g, b] = sliderToRgb(hue);
  await invoke("send_gaia_command", { address, vendorId: 0x5054, commandId: 0x0204, payload: [r, g, b] });
}

async function runLamp(mood: number, type: number, hue: number) {
  const address = getActiveDeviceAddress();
  if (!address) return;
  const [r, g, b] = sliderToRgb(hue);
  const rounded = Math.round(mood);
  await invoke("send_gaia_command", {
    address,
    vendorId: 0x5054,
    commandId: 0x0212,
    payload: [rounded, type, r, g, b],
  });
}

async function stopLamp() {
  const address = getActiveDeviceAddress();
  if (!address) return;
  await invoke("send_gaia_command", { address, vendorId: 0x5054, commandId: 0x0213, payload: [] });
}

export function handleLampStatePacket(connectedAddress: string, dataPayload: number[]) {
  if (dataPayload.length < 6) return;
  const lampOn = dataPayload[0] === 1;
  const lampBrightness = dataPayload[1];
  const type = dataPayload[2];
  const lampType = type >= 1 && type <= 5 ? type : 1;
  const [r, g, b] = dataPayload.slice(3, 6);
  const lampHue = rgbToSlider(r, g, b);
  if (connectedAddress) {
    updateDeviceData(connectedAddress, {
      lampOn, lampBrightness, lampType, lampHue,
      lampLastNonZero: lampBrightness > 0 ? lampBrightness : getDeviceData(connectedAddress).lampLastNonZero,
    });
  }
  if (connectedAddress && connectedAddress === getActiveDeviceAddress()) updateLampUI();
}
