import { invoke } from "@tauri-apps/api/core";
import { getActiveDeviceAddress } from "../state/registry";
import { updateDeviceData } from "../state/telemetry";
import { getActiveDeviceData, updateActiveDeviceData, isActiveDeviceConnected } from "../state/active";
import { updateRangeFill } from "../components/range";
import { logLine } from "../utils/formatter";

let volumeSliderEl: HTMLInputElement | null = null;
const VOLUME_SEND_BUCKET_COUNT = 30;
let lastVolumeAddress: string | null = null;
let lastVolumeBucket: number | null = null;

function toVolumeBucket(value: number) {
  const clamped = Math.max(0, Math.min(30, value));
  return Math.round((clamped / 30) * VOLUME_SEND_BUCKET_COUNT);
}

function fromVolumeBucket(bucket: number) {
  const clampedBucket = Math.max(0, Math.min(VOLUME_SEND_BUCKET_COUNT, bucket));
  return (clampedBucket / VOLUME_SEND_BUCKET_COUNT) * 30;
}

export function initVolume() {
  volumeSliderEl = document.querySelector<HTMLInputElement>("#volumeSlider");
  volumeSliderEl?.addEventListener("input", () => {
    if (!volumeSliderEl) return;
    const value = Number(volumeSliderEl.value);
    updateActiveDeviceData({ volume: value });
    updateVolumeUI();
    if (!isActiveDeviceConnected()) return;
    setVolume(value);
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
  const address = getActiveDeviceAddress();
  if (!address) return;
  try {
    await invoke("send_gaia_command", { address, vendorId: 0x5054, commandId: 0x0401, payload: [] });
    logLine("Volume request (5054 0401)", "OUT");
  } catch (err) {
    logLine(String(err), "SYS");
  }
}

async function setVolume(value: number) {
  const address = getActiveDeviceAddress();
  if (!address) return;
  try {
    const bucket = toVolumeBucket(value);
    const normalizedAddress = address.toLowerCase();
    if (lastVolumeAddress === normalizedAddress && lastVolumeBucket === bucket) {
      return;
    }
    const quantized = fromVolumeBucket(bucket);
    const rounded = Math.round(quantized);
    await invoke("send_gaia_command", { address, vendorId: 0x5054, commandId: 0x0201, payload: [rounded] });
    lastVolumeAddress = normalizedAddress;
    lastVolumeBucket = bucket;
  } catch (err) {
    logLine(String(err), "SYS");
  }
}

export function handleVolumePacket(connectedAddress: string, dataPayload: number[]) {
  if (dataPayload.length >= 1) {
    if (connectedAddress) updateDeviceData(connectedAddress, { volume: dataPayload[0] });
    if (connectedAddress && connectedAddress === getActiveDeviceAddress()) updateVolumeUI();
  }
}
