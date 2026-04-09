import { invoke } from "@tauri-apps/api/core";
import { getSelectedSingleDeviceAddress } from "../state/registry";
import { updateDeviceData } from "../state/telemetry";
import { getSelectionAnchorDeviceData, updateSelectionAnchorDeviceData } from "../state/active";
import { getControlTargetAddresses } from "../state/multi-control";
import { updateRangeFill } from "../components/range";
import { logLine } from "../utils/formatter";

let volumeSliderEl: HTMLInputElement | null = null;
const VOLUME_SEND_BUCKET_COUNT = 30;
const lastVolumeBucketByAddress = new Map<string, number>();

async function runBroadcast(tasks: Promise<unknown>[]) {
  const results = await Promise.allSettled(tasks);
  results.forEach((result) => {
    if (result.status === "rejected") {
      logLine(String(result.reason), "SYS");
    }
  });
}

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
    updateSelectionAnchorDeviceData({ volume: value });
    updateVolumeUI();
    if (getControlTargetAddresses().length === 0) return;
    setVolume(value);
  });
}

export function updateVolumeUI() {
  if (!volumeSliderEl) return;
  const data = getSelectionAnchorDeviceData();
  const v = data.volume === null || Number.isNaN(data.volume) ? 0 : data.volume;
  volumeSliderEl.value = String(v);
  updateRangeFill(volumeSliderEl);
}

export async function requestVolume() {
  const address = getSelectedSingleDeviceAddress();
  if (!address) return;
  try {
    await invoke("send_gaia_command", { address, vendorId: 0x5054, commandId: 0x0401, payload: [] });
    logLine("Volume request (5054 0401)", "OUT");
  } catch (err) {
    logLine(String(err), "SYS");
  }
}

async function setVolume(value: number) {
  const addresses = getControlTargetAddresses();
  if (addresses.length === 0) return;
  try {
    const bucket = toVolumeBucket(value);
    const quantized = fromVolumeBucket(bucket);
    const rounded = Math.round(quantized);
    const sendTasks = addresses.map(async (address) => {
      const normalizedAddress = address.toLowerCase();
      if (lastVolumeBucketByAddress.get(normalizedAddress) === bucket) {
        return;
      }
      await invoke("send_gaia_command", { address, vendorId: 0x5054, commandId: 0x0201, payload: [rounded] });
      lastVolumeBucketByAddress.set(normalizedAddress, bucket);
    });
    await runBroadcast(sendTasks);
  } catch (err) {
    logLine(String(err), "SYS");
  }
}

export function handleVolumePacket(connectedAddress: string, dataPayload: number[]) {
  if (dataPayload.length >= 1) {
    if (connectedAddress) updateDeviceData(connectedAddress, { volume: dataPayload[0] });
    if (connectedAddress && connectedAddress === getSelectedSingleDeviceAddress()) updateVolumeUI();
  }
}
