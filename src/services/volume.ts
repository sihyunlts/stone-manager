import { invoke } from "@tauri-apps/api/core";
import { getActiveDeviceAddress } from "../state/registry";
import { updateDeviceData } from "../state/telemetry";
import { getActiveDeviceData, updateActiveDeviceData, isActiveDeviceConnected } from "../state/active";
import { updateRangeFill } from "../components/range";
import { logLine } from "../utils/formatter";

let volumeSliderEl: HTMLInputElement | null = null;
let volumeDebounce: ReturnType<typeof setTimeout> | null = null;

export function initVolume() {
  volumeSliderEl = document.querySelector<HTMLInputElement>("#volumeSlider");
  volumeSliderEl?.addEventListener("input", () => {
    if (!volumeSliderEl) return;
    const value = Number(volumeSliderEl.value);
    updateActiveDeviceData({ volume: value });
    updateVolumeUI();
    if (volumeDebounce) clearTimeout(volumeDebounce);
    volumeDebounce = setTimeout(() => {
      if (!isActiveDeviceConnected()) return;
      setVolume(value);
    }, 150);
  });
}

export function updateVolumeUI() {
  if (!volumeSliderEl) return;
  const data = getActiveDeviceData();
  const v = data.volume === null || Number.isNaN(data.volume) ? 0 : data.volume;
  volumeSliderEl.value = String(v);
  updateRangeFill(volumeSliderEl);
}

export async function requestVolume() {
  try {
    await invoke("send_gaia_command", { vendorId: 0x5054, commandId: 0x0401, payload: [] });
    logLine("Volume request (5054 0401)", "OUT");
  } catch (err) {
    logLine(String(err), "SYS");
  }
}

async function setVolume(value: number) {
  try {
    const rounded = Math.round(value);
    await invoke("send_gaia_command", { vendorId: 0x5054, commandId: 0x0201, payload: [rounded] });
  } catch (err) {
    logLine(String(err), "SYS");
  }
}

export function handleVolumePacket(connectedAddress: string | null, dataPayload: number[]) {
  if (dataPayload.length >= 1) {
    if (connectedAddress) updateDeviceData(connectedAddress, { volume: dataPayload[0] });
    if (connectedAddress && connectedAddress === getActiveDeviceAddress()) updateVolumeUI();
  }
}
