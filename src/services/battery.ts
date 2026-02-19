import { invoke } from "@tauri-apps/api/core";
import { getActiveDeviceAddress } from "../state/registry";
import { updateDeviceData } from "../state/telemetry";
import { getActiveDeviceData, isActiveDeviceConnected } from "../state/active";
import { logLine } from "../utils/formatter";

let batteryEl: HTMLElement | null = null;
let batteryIconEl: HTMLSpanElement | null = null;
let batteryTimer: ReturnType<typeof setInterval> | null = null;
let batteryStepToggleEl: HTMLInputElement | null = null;
const BATTERY_LEVEL_DISPLAY_KEY = "stone.battery_level_display_v1";
let useBatteryLevelDisplay = loadBatteryLevelDisplayPreference();

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampBatteryStep(step: number) {
  return Math.max(0, Math.min(5, Math.round(step)));
}

function batteryStepToPercent(step: number) {
  const s = clampBatteryStep(step);
  if (s <= 1) return 20;
  if (s === 2) return 40;
  if (s === 3) return 60;
  if (s === 4) return 80;
  return 100;
}

function loadBatteryLevelDisplayPreference() {
  try {
    return window.localStorage.getItem(BATTERY_LEVEL_DISPLAY_KEY) === "1";
  } catch {
    return false;
  }
}

function saveBatteryLevelDisplayPreference(next: boolean) {
  try {
    window.localStorage.setItem(BATTERY_LEVEL_DISPLAY_KEY, next ? "1" : "0");
  } catch {
  }
}

export function initBattery() {
  batteryEl = document.querySelector<HTMLElement>("#battery");
  batteryIconEl = document.querySelector<HTMLSpanElement>("#batteryIcon");
  batteryEl?.addEventListener("click", requestBattery);
  batteryStepToggleEl = document.querySelector<HTMLInputElement>("#settingsBatteryStepToggle");
  if (batteryStepToggleEl) {
    batteryStepToggleEl.checked = useBatteryLevelDisplay;
    batteryStepToggleEl.addEventListener("change", () => {
      useBatteryLevelDisplay = !!batteryStepToggleEl?.checked;
      saveBatteryLevelDisplayPreference(useBatteryLevelDisplay);
      updateBatteryLabel();
    });
  }
}

export function stopBatteryPolling() {
  if (batteryTimer) {
    clearInterval(batteryTimer);
    batteryTimer = null;
  }
}

export function startBatteryPolling() {
  stopBatteryPolling();
  batteryTimer = setInterval(requestBattery, 30_000);
}

export function resetBatteryState() {
  if (batteryEl) batteryEl.textContent = "--";
  if (batteryIconEl) batteryIconEl.textContent = "battery_android_question";
  void invoke("set_tray_battery", { percent: null, charging: false, full: false });
}

export async function requestBattery() {
  const address = getActiveDeviceAddress();
  if (!address) return;
  try {
    await invoke("send_gaia_command", { address, vendorId: 0x5054, commandId: 0x0455, payload: [] });
    await invoke("send_gaia_command", { address, vendorId: 0x5054, commandId: 0x0456, payload: [] });
    logLine("Battery request (5054 0455)", "OUT");
  } catch (err) {
    logLine(String(err), "SYS");
  }
}

export function updateBatteryLabel() {
  if (!batteryEl || !batteryIconEl) return;
  if (!isActiveDeviceConnected()) {
    batteryEl.textContent = "--";
    batteryIconEl.textContent = "battery_android_question";
    void invoke("set_tray_battery", { percent: null, charging: false, full: false });
    return;
  }
  const { batteryStep, batteryLevel, dcState } = getActiveDeviceData();
  const percent = useBatteryLevelDisplay
    ? (
      batteryLevel !== null
        ? clampPercent(batteryLevel)
        : batteryStep !== null
          ? batteryStepToPercent(batteryStep)
          : null
    )
    : (
      batteryStep !== null
        ? batteryStepToPercent(batteryStep)
        : null
    );

  if (percent === null) {
    batteryEl.textContent = "--";
    batteryIconEl.textContent = "battery_android_question";
    void invoke("set_tray_battery", { percent: null, charging: false, full: false });
    return;
  }

  let suffix = "";
  const isFull = dcState === 1 && percent >= 100;
  const isCharging = dcState === 3;
  let icon = "battery_android_question";

  if (isCharging) {
    icon = "battery_android_frame_bolt";
    suffix = " (충전 중)";
  } else if (isFull) {
    icon = "battery_android_frame_full";
    suffix = " (충전 완료)";
  } else {
    if (percent >= 95) icon = "battery_android_frame_full";
    else if (percent >= 80) icon = "battery_android_6";
    else if (percent >= 60) icon = "battery_android_5";
    else if (percent >= 40) icon = "battery_android_4";
    else if (percent >= 20) icon = "battery_android_2";
    else icon = "battery_android_1";
  }

  batteryEl.textContent = `${percent}%${suffix}`;
  batteryIconEl.textContent = icon;
  void invoke("set_tray_battery", { percent, charging: isCharging, full: isFull });
}

export function handleBatteryStepPacket(connectedAddress: string, dataPayload: number[]) {
  if (dataPayload.length >= 1 && connectedAddress) {
    const patch: { batteryStep: number; batteryLevel?: number } = {
      batteryStep: dataPayload[0],
    };
    if (dataPayload.length >= 2) {
      patch.batteryLevel = clampPercent(dataPayload[1]);
    }
    updateDeviceData(connectedAddress, patch);
    if (connectedAddress === getActiveDeviceAddress()) updateBatteryLabel();
  }
}

export function handleDcStatePacket(connectedAddress: string, dataPayload: number[]) {
  if (dataPayload.length >= 1 && connectedAddress) {
    updateDeviceData(connectedAddress, { dcState: dataPayload[0] });
    if (connectedAddress === getActiveDeviceAddress()) updateBatteryLabel();
  }
}
