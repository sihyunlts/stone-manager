import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen, type Event } from "@tauri-apps/api/event";
import { bindDevPage, renderDevPage } from "./pages/dev";
import { bindSettingsPage, renderSettingsPage } from "./pages/settings";
import {
  initConnectController,
  type ConnectResultEvent,
  type DeviceStateEvent,
} from "./services/bluetooth";
import { renderPairingPage } from "./pages/pairing";
import { renderLicensesPage } from "./pages/licenses";
import { updateRangeFill } from "./components/range";
import { bindSelect, renderSelect } from "./components/select";
import { animate } from "motion";
import {
  getConnectionSnapshot,
  setConnectionSnapshot,
  subscribeConnection,
  type ConnectionState,
} from "./state/connection";
import {
  getActiveDeviceAddress,
  getRegisteredDevices,
  setActiveDeviceAddress,
  subscribeActiveDevice,
  subscribeRegisteredDevices,
} from "./state/devices";
import {
  getDefaultDeviceData,
  getDeviceData,
  updateDeviceData,
} from "./state/device-data";
import { renderHomePage } from "./pages/home";

type GaiaPacketEvent = {
  vendor_id: number;
  command_id: number;
  command: number;
  ack: boolean;
  flags: number;
  payload: number[];
  status?: number | null;
};

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector(selector);
  if (!node) {
    throw new Error(`Missing element: ${selector}`);
  }
  return node as T;
}

function toHex(value: number, width: number) {
  return value.toString(16).toUpperCase().padStart(width, "0");
}

function parseHexBytes(input: string): number[] {
  const cleaned = input.replace(/[^0-9a-fA-F]/g, "");
  if (cleaned.length === 0) return [];
  if (cleaned.length % 2 !== 0) {
    throw new Error("Payload hex must have even length");
  }
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return bytes;
}

export function initApp() {
  const app = el<HTMLDivElement>("#app");
  app.innerHTML = `
    <div class="app-shell">
      <div id="pageHost">
        ${renderHomePage()}
        ${renderPairingPage()}
        ${renderSettingsPage()}
        ${renderDevPage()}
        ${renderLicensesPage()}
      </div>
    </div>
  `;

  const navBackButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-back"));
  const navSidebarButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-sidebar"));
  const navConnect = el<HTMLButtonElement>("#navConnect");
  const navSettings = el<HTMLButtonElement>("#navSettings");
  const pageHost = el<HTMLDivElement>("#pageHost");
  const pageHome = el<HTMLDivElement>("#page-home");
  const pageDev = el<HTMLDivElement>("#page-dev");
  const pageSettings = el<HTMLDivElement>("#page-settings");
  const pagePairing = el<HTMLDivElement>("#page-pairing");
  const pageLicenses = el<HTMLDivElement>("#page-licenses");
  const homeShell = pageHome;
  const appTitle = el<HTMLDivElement>("#appTitle");
  const status = el<HTMLDivElement>("#status");
  const battery = el<HTMLDivElement>("#battery");
  const batteryIcon = el<HTMLSpanElement>("#batteryIcon");
  const statusAction = el<HTMLButtonElement>("#statusAction");
  const sectionSound = el<HTMLElement>("#sectionSound");
  const sectionLamp = el<HTMLElement>("#sectionLamp");
  const settingsStoneInfo = document.querySelector<HTMLElement>("#settingsStoneInfo");
  const volumeSlider = el<HTMLInputElement>("#volumeSlider");
  const lampToggle = el<HTMLInputElement>("#lampToggle");
  const lampBrightness = el<HTMLInputElement>("#lampBrightness");
  const lampHue = el<HTMLInputElement>("#lampHue");
  let batteryTimer: ReturnType<typeof setInterval> | null = null;
  let volumeDebounce: ReturnType<typeof setTimeout> | null = null;
  let lampDebounce: ReturnType<typeof setTimeout> | null = null;
  let connectController: ReturnType<typeof initConnectController> | null = null;
  let deviceSelectBinding: ReturnType<typeof bindSelect> | null = null;

  let currentPage: "home" | "dev" | "settings" | "pairing" | "licenses" = "home";
  let isTransitioning = false;
  const pageHistory: Array<"home" | "dev" | "settings" | "pairing" | "licenses"> = [];

  pageHome.style.filter = "brightness(1)";
  pageDev.style.zIndex = "0";
  pageHome.style.zIndex = "1";
  animate(pageHome, { x: "0%" }, { duration: 0 });
  animate(pageDev, { x: "100%" }, { duration: 0 });
  animate(pageSettings, { x: "100%" }, { duration: 0 });
  animate(pagePairing, { x: "100%" }, { duration: 0 });
  animate(pageLicenses, { x: "100%" }, { duration: 0 });
  function resetPageStack() {
    pageHome.style.zIndex = "0";
    pageDev.style.zIndex = "0";
    pageSettings.style.zIndex = "0";
    pagePairing.style.zIndex = "0";
    pageLicenses.style.zIndex = "0";
  }

  async function navigate(
    to: "home" | "dev" | "settings" | "pairing" | "licenses",
    direction: "forward" | "back"
  ) {
    if (isTransitioning || to === currentPage) return;
    isTransitioning = true;
    pageHost.style.pointerEvents = "none";
    const bring =
      to === "dev"
        ? pageDev
        : to === "settings"
          ? pageSettings
      : to === "pairing"
        ? pagePairing
        : to === "licenses"
          ? pageLicenses
          : pageHome;
    const leave =
      currentPage === "dev"
        ? pageDev
        : currentPage === "settings"
          ? pageSettings
      : currentPage === "pairing"
        ? pagePairing
        : currentPage === "licenses"
          ? pageLicenses
          : pageHome;
    resetPageStack();
    if (direction === "forward") {
      bring.style.zIndex = "2";
      leave.style.zIndex = "1";
      const springConfig = {
        type: "spring" as const,
        stiffness: 450,
        damping: 40
      };

      await Promise.all([
        animate(bring, { x: ["100%", "0%"] }, springConfig).finished,
        animate(leave, { x: ["0%", "-20%"] }, springConfig).finished,
      ]);
    } else {
      bring.style.zIndex = "1";
      leave.style.zIndex = "2";
      const springConfig = {
        type: "spring" as const,
        stiffness: 600,
        damping: 60,
      };

      await Promise.all([
        animate(leave, { x: ["0%", "100%"] }, springConfig).finished,
        animate(bring, { x: ["-20%", "0%"] }, springConfig).finished,
      ]);
      leave.style.zIndex = "0";
    }
    currentPage = to;
    if (to === "dev" || to === "settings") {
      requestAllDeviceInfo();
    }
    pageHost.style.pointerEvents = "";
    isTransitioning = false;
  }

  function goTo(to: "home" | "dev" | "settings" | "pairing" | "licenses") {
    if (isTransitioning || to === currentPage) return;
    pageHistory.push(currentPage);
    void navigate(to, "forward");
  }

  function goBack() {
    if (isTransitioning) return;
    const target = pageHistory.pop();
    void navigate(target ?? "home", "back");
  }

  function logLine(line: string, tone: "IN" | "OUT" | "SYS" = "SYS") {
    void invoke("log_line", { line, tone, ts: "" });
  }

  function getActiveDeviceData() {
    const address = getActiveDeviceAddress();
    if (!address) return getDefaultDeviceData();
    return getDeviceData(address);
  }

  function updateActiveDeviceData(patch: Partial<ReturnType<typeof getDeviceData>>) {
    const address = getActiveDeviceAddress();
    if (!address) return null;
    return updateDeviceData(address, patch);
  }

  function isActiveDeviceConnected() {
    const active = getActiveDeviceAddress();
    const { state, address } = getConnectionSnapshot();
    return !!active && state === "connected" && address === active;
  }

  function getActiveDeviceLabel() {
    const address = getActiveDeviceAddress();
    if (!address) return null;
    const registered = getRegisteredDevices().find((device) => device.address === address);
    return registered?.name ?? address;
  }

  function renderDeviceTitle() {
    appTitle.setAttribute("data-tauri-drag-region", "false");
    const devices = getRegisteredDevices();
    if (devices.length === 0) {
      appTitle.textContent = "STONE 매니저";
      deviceSelectBinding = null;
      return;
    }
    const active = getActiveDeviceAddress() ?? devices[0]?.address ?? null;
    if (active && active !== getActiveDeviceAddress()) {
      setActiveDeviceAddress(active);
    }
    appTitle.innerHTML = renderSelect({
      id: "deviceSelect",
      options: devices.map((device) => ({
        value: device.address,
        label: device.name ?? device.address,
      })),
      value: active ?? "",
    });
    deviceSelectBinding = bindSelect("deviceSelect", (value) => {
      setActiveDeviceAddress(value);
    });
  }

  function syncActiveDeviceUI() {
    updateConnectionStatus();
    updateStatusAction();
    updateBatteryLabel();
    updateVolumeUI();
    updateLampUI();
    const connected = isActiveDeviceConnected();
    sectionSound.style.display = connected ? "" : "none";
    sectionLamp.style.display = connected ? "" : "none";
    if (settingsStoneInfo) {
      settingsStoneInfo.style.display = connected ? "" : "none";
    }
  }

  connectController = initConnectController({
    logLine,
    getConnectionState: () => getConnectionSnapshot().state,
    getConnectedAddress: () => getConnectionSnapshot().address,
    setConnectionState,
    setConnected,
    setDisconnected,
    goToPairing: () => goTo("pairing"),
  });



  function stopBatteryPolling() {
    if (batteryTimer) {
      clearInterval(batteryTimer);
      batteryTimer = null;
    }
  }

  function resetBatteryState() {
    battery.textContent = "--";
    batteryIcon.textContent = "battery_android_question";
    void invoke("set_tray_battery", { percent: null, charging: false, full: false });
  }

  const lampTypeSelect = bindSelect("lampType", (value) => {
    const next = Number(value);
    const data = updateActiveDeviceData({ lampType: next });
    if (!data || !data.lampOn) return;
    setLampType(next).catch((err) => logLine(String(err), "SYS"));
    if (next === 1) {
      setLampColor(data.lampHue).catch((err) => logLine(String(err), "SYS"));
    }
  });

  function updateLampUI() {
    const data = getActiveDeviceData();
    if (data.lampBrightness === null) {
      lampBrightness.value = "0";
    } else {
      lampBrightness.value = String(data.lampBrightness);
    }
    updateRangeFill(lampBrightness);
    lampToggle.checked = data.lampOn;
    lampTypeSelect?.setValue(data.lampType);
    lampHue.value = String(data.lampHue);
    updateRangeFill(lampHue);
  }

  function sliderToRgb(value: number) {
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

  function rgbToSlider(r: number, g: number, b: number) {
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

  async function requestLampState() {
    try {
      await invoke("send_gaia_command", { vendorId: 0x5054, commandId: 0x0411, payload: [] });
      logLine("Lamp request (5054 0411)", "OUT");
    } catch (err) {
      logLine(String(err), "SYS");
    }
  }

  async function setLampBrightness(value: number) {
    const rounded = Math.round(value);
    await invoke("send_gaia_command", { vendorId: 0x5054, commandId: 0x0202, payload: [rounded] });
  }

  async function setLampType(value: number) {
    await invoke("send_gaia_command", { vendorId: 0x5054, commandId: 0x0203, payload: [value] });
  }

  async function setLampColor(hue: number) {
    const [r, g, b] = sliderToRgb(hue);
    await invoke("send_gaia_command", { vendorId: 0x5054, commandId: 0x0204, payload: [r, g, b] });
  }

  async function runLamp(mood: number, type: number, hue: number) {
    const [r, g, b] = sliderToRgb(hue);
    const rounded = Math.round(mood);
    await invoke("send_gaia_command", {
      vendorId: 0x5054,
      commandId: 0x0212,
      payload: [rounded, type, r, g, b],
    });
  }

  async function stopLamp() {
    await invoke("send_gaia_command", { vendorId: 0x5054, commandId: 0x0213, payload: [] });
  }

  function updateVolumeUI() {
    const data = getActiveDeviceData();
    const v = (data.volume === null || Number.isNaN(data.volume)) ? 0 : data.volume;
    volumeSlider.value = String(v);
    updateRangeFill(volumeSlider);
  }

  async function requestVolume() {
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

  function setConnected(address: string) {
    setConnectionState("connected", address);
    setActiveDeviceAddress(address);
    requestBattery().catch((err) => logLine(String(err), "SYS"));
    requestVolume().catch((err) => logLine(String(err), "SYS"));
    requestLampState().catch((err) => logLine(String(err), "SYS"));
    stopBatteryPolling();
    batteryTimer = setInterval(requestBattery, 30_000);
    updateVolumeUI();
    updateLampUI();
  }

  function setDisconnected() {
    stopBatteryPolling();
    resetBatteryState();
    updateVolumeUI();
    updateLampUI();
    setConnectionState("idle", null);
  }

  function updateConnectionStatus() {
    const { state, address } = getConnectionSnapshot();
    const active = getActiveDeviceAddress();
    switch (state) {
      case "connecting":
        status.textContent = "연결 중...";
        status.classList.remove("connected");
        break;
      case "disconnecting":
        status.textContent = "연결 해제 중...";
        status.classList.remove("connected");
        break;
      case "connected": {
        if (active && address !== active) {
          status.textContent = `${getActiveDeviceLabel() ?? "STONE"}이 연결되지 않음`;
          status.classList.remove("connected");
          break;
        }
        const label = address
          ? connectController?.getDeviceLabel(address) ?? address
          : "Unknown";
        status.textContent = `${label}`;
        status.classList.add("connected");
        break;
      }
      case "idle":
      default:
        status.textContent = `${getActiveDeviceLabel() ?? "STONE"}이 연결되지 않음`;
        status.classList.remove("connected");
        break;
    }
  }

  function updateStatusAction() {
    const active = getActiveDeviceAddress();
    if (!active) {
      statusAction.style.display = "none";
      return;
    }
    statusAction.style.display = "";
    if (isActiveDeviceConnected()) {
      statusAction.textContent = "연결 끊기";
      statusAction.dataset.action = "disconnect";
    } else {
      statusAction.textContent = "연결";
      statusAction.dataset.action = "connect";
    }
  }

  function setConnectionState(state: ConnectionState, address?: string | null) {
    const nextAddress = address !== undefined ? address : getConnectionSnapshot().address;
    setConnectionSnapshot(state, nextAddress);
    updateConnectionStatus();
  }

  async function requestBattery() {
    try {
      await invoke("send_gaia_command", { vendorId: 0x5054, commandId: 0x0455, payload: [] });
      await invoke("send_gaia_command", { vendorId: 0x5054, commandId: 0x0456, payload: [] });
      logLine("Battery request (5054 0455)", "OUT");
    } catch (err) {
      logLine(String(err), "SYS");
    }
  }

  function updateBatteryLabel() {
    if (!isActiveDeviceConnected()) {
      battery.textContent = "--";
      batteryIcon.textContent = "battery_android_question";
      void invoke("set_tray_battery", { percent: null, charging: false, full: false });
      return;
    }
    const { batteryStep, dcState } = getActiveDeviceData();
    if (batteryStep === null) {
      battery.textContent = "--";
      batteryIcon.textContent = "battery_android_question";
      void invoke("set_tray_battery", { percent: null, charging: false, full: false });
      return;
    }
    let percent: number;
    switch (batteryStep) {
      case 0:
      case 1:
        percent = 20;
        break;
      case 2:
        percent = 40;
        break;
      case 3:
        percent = 60;
        break;
      case 4:
        percent = 80;
        break;
      case 5:
        percent = 100;
        break;
      default:
        percent = batteryStep;
        break;
    }
    let suffix = "";
    const isFull = dcState === 1 && batteryStep === 5;
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

    battery.textContent = `${percent}%${suffix}`;
    batteryIcon.textContent = icon;
    void invoke("set_tray_battery", { percent, charging: isCharging, full: isFull });
  }

  async function sendCommand(vendorIdHex: string, commandIdHex: string, payloadHex: string) {

    const vendorId = parseInt(vendorIdHex, 16);
    const commandId = parseInt(commandIdHex, 16);
    if (Number.isNaN(vendorId) || Number.isNaN(commandId)) {
      logLine("Invalid vendor or command id", "SYS");
      return;
    }

    let payload: number[] = [];
    try {
      payload = parseHexBytes(payloadHex);
    } catch (err) {
      logLine(String(err), "SYS");
      return;
    }

    try {
      await invoke("send_gaia_command", { vendorId, commandId, payload });
      const payloadText = payload.length
        ? payload.map((b) => toHex(b, 2)).join(" ")
        : "<empty>";
      logLine(`${toHex(vendorId, 4)} ${toHex(commandId, 4)} ${payloadText}`, "OUT");
    } catch (err) {
      logLine(String(err), "SYS");
    }
  }

  const devInfoName = document.querySelector<HTMLDivElement>("#devInfoName");
  const devInfoFirmware = document.querySelector<HTMLDivElement>("#devInfoFirmware");
  const devInfoMac = document.querySelector<HTMLDivElement>("#devInfoMac");
  const devInfoRssi = document.querySelector<HTMLDivElement>("#devInfoRssi");
  const devInfoWheel = document.querySelector<HTMLDivElement>("#devInfoWheel");
  const infoName = document.querySelector<HTMLDivElement>("#settingsName");
  const infoFirmware = document.querySelector<HTMLDivElement>("#settingsFirmware");
  const infoMac = document.querySelector<HTMLDivElement>("#settingsMac");
  const infoRssi = document.querySelector<HTMLDivElement>("#settingsRssi");
  const infoWheel = document.querySelector<HTMLDivElement>("#settingsWheel");
  const settingsAppVersion = document.querySelector<HTMLDivElement>("#settingsAppVersion");
  const settingsAppVersionRow = document.querySelector<HTMLDivElement>("#settingsAppVersionRow");

  function setDevInfo(target: HTMLDivElement | null, value: string) {
    if (target) target.textContent = value;
  }

  function setInfoPair(value: string, devTarget: HTMLDivElement | null, infoTarget: HTMLDivElement | null) {
    setDevInfo(devTarget, value);
    setDevInfo(infoTarget, value);
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

  async function requestDeviceInfo(commandId: number) {
    try {
      await invoke("send_gaia_command", { vendorId: 0x5054, commandId, payload: [] });
      logLine(`Device info request (${toHex(0x5054, 4)} ${toHex(commandId, 4)})`, "OUT");
    } catch (err) {
      logLine(String(err), "SYS");
    }
  }

  function requestAllDeviceInfo() {
    requestDeviceInfo(0x0451).catch(() => {});
    requestDeviceInfo(0x0452).catch(() => {});
    requestDeviceInfo(0x0453).catch(() => {});
    requestDeviceInfo(0x0454).catch(() => {});
    requestDeviceInfo(0x0457).catch(() => {});
  }

  async function requestSdpQuery() {
    const address = getActiveDeviceAddress();
    if (!address) {
      logLine("No active device selected", "SYS");
      return;
    }
    try {
      await invoke("sdp_query", { address });
      logLine(`SDP query request (${address})`, "SYS");
    } catch (err) {
      logLine(String(err), "SYS");
    }
  }

  bindDevPage({
    onSend: sendCommand,
    onSdpQuery: requestSdpQuery,
  });
  loadAppVersion().catch(() => {});
  battery.addEventListener("click", requestBattery);
  updateVolumeUI();
  updateLampUI();
  volumeSlider.addEventListener("input", () => {
    const value = Number(volumeSlider.value);
    updateActiveDeviceData({ volume: value });
    updateVolumeUI();
    if (volumeDebounce) {
      clearTimeout(volumeDebounce);
    }
    volumeDebounce = setTimeout(() => {
      if (!isActiveDeviceConnected()) return;
      setVolume(value);
    }, 150);
  });
  lampToggle.addEventListener("change", () => {
    const currentData = getActiveDeviceData();
    const current = currentData.lampBrightness ?? 0;
    const nextValue = lampToggle.checked
      ? (current > 0 ? current : currentData.lampLastNonZero)
      : 0;
    const updated = updateActiveDeviceData({
      lampBrightness: nextValue,
      lampOn: lampToggle.checked,
      lampLastNonZero: nextValue > 0 ? nextValue : currentData.lampLastNonZero,
    });
    if (nextValue > 0) {
      updateActiveDeviceData({ lampLastNonZero: nextValue });
    }
    updateLampUI();
    if (!updated || !isActiveDeviceConnected()) return;
    if (updated.lampOn) {
      runLamp(nextValue, updated.lampType, updated.lampHue).catch((err) => logLine(String(err), "SYS"));
    } else {
      stopLamp().catch((err) => logLine(String(err), "SYS"));
    }
  });
  lampBrightness.addEventListener("input", () => {
    const value = Number(lampBrightness.value);
    const updated = updateActiveDeviceData({
      lampBrightness: value,
      lampLastNonZero: value > 0 ? value : getActiveDeviceData().lampLastNonZero,
    });
    if (value > 0) {
      updateActiveDeviceData({ lampLastNonZero: value });
    }
    updateLampUI();
    if (lampDebounce) {
      clearTimeout(lampDebounce);
    }
    lampDebounce = setTimeout(() => {
      if (!updated || !updated.lampOn || !isActiveDeviceConnected()) return;
      setLampBrightness(value).catch((err) => logLine(String(err), "SYS"));
    }, 150);
    updateRangeFill(lampBrightness);
  });
  lampHue.addEventListener("input", () => {
    const nextHue = Number(lampHue.value);
    const updated = updateActiveDeviceData({ lampHue: nextHue });
    updateRangeFill(lampHue);
    if (!updated || !updated.lampOn || !isActiveDeviceConnected()) return;
    if (updated.lampType === 1) {
      setLampColor(updated.lampHue).catch((err) => logLine(String(err), "SYS"));
    }
  });
  bindSettingsPage(() => {
    logLine("Developer menu unlocked", "SYS");
    goTo("dev");
  });
  statusAction.addEventListener("click", () => {
    const active = getActiveDeviceAddress();
    if (!active || !connectController) return;
    if (isActiveDeviceConnected()) {
      void connectController.disconnect();
    } else {
      void connectController.connectAddress(active);
    }
  });
  navSettings.addEventListener("click", () => {
    goTo("settings");
  });
  navConnect.addEventListener("click", () => {
    goTo("pairing");
  });
  const navLicenses = el<HTMLDivElement>("#navLicenses");
  if (navLicenses) {
    navLicenses.addEventListener("click", () => {
      goTo("licenses");
    });
  }

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest("[data-url]") as HTMLElement;
    if (item) {
      const url = item.dataset.url;
      if (url) {
        invoke("open_url", { url }).catch((err) => logLine(String(err), "SYS"));
      }
    }
  });
  navBackButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      goBack();
    });
  });

  navSidebarButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      homeShell.classList.toggle("is-sidebar-collapsed");
    });
  });

  renderDeviceTitle();
  syncActiveDeviceUI();
  subscribeRegisteredDevices(() => {
    renderDeviceTitle();
    syncActiveDeviceUI();
  });
  subscribeActiveDevice(() => {
    renderDeviceTitle();
    syncActiveDeviceUI();
  });
  subscribeConnection(() => {
    syncActiveDeviceUI();
  });

  listen<ConnectResultEvent>("bt_connect_result", (event: Event<ConnectResultEvent>) => {
    connectController.handleConnectResult(event.payload);
  });

  listen<DeviceStateEvent>("bt_device_event", (event: Event<DeviceStateEvent>) => {
    connectController.handleDeviceEvent(event.payload);
  });

  listen<GaiaPacketEvent>("gaia_packet", (event: Event<GaiaPacketEvent>) => {
    const p = event.payload;
    const dataPayload = p.ack && p.payload.length > 0 ? p.payload.slice(1) : p.payload;
    const connectedAddress = getConnectionSnapshot().address;
    if (p.vendor_id === 0x5054 && p.command === 0x0455 && p.ack) {
      if (dataPayload.length >= 1) {
        if (connectedAddress) {
          updateDeviceData(connectedAddress, { batteryStep: dataPayload[0] });
        }
        if (connectedAddress && connectedAddress === getActiveDeviceAddress()) {
          updateBatteryLabel();
        }
      }
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0451 && p.ack) {
      const name = new TextDecoder().decode(new Uint8Array(dataPayload)).trim();
      if (name) setInfoPair(name, devInfoName, infoName);
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0452 && p.ack) {
      const firmware = new TextDecoder().decode(new Uint8Array(dataPayload)).trim();
      if (firmware) setInfoPair(firmware, devInfoFirmware, infoFirmware);
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0453 && p.ack) {
      const mac = new TextDecoder().decode(new Uint8Array(dataPayload)).trim();
      if (mac) setInfoPair(mac, devInfoMac, infoMac);
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0454 && p.ack) {
      if (dataPayload.length >= 1) {
        const rssi = (dataPayload[0] & 0x80) ? dataPayload[0] - 256 : dataPayload[0];
        setInfoPair(`${rssi} dBm`, devInfoRssi, infoRssi);
      }
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0457 && p.ack) {
      if (dataPayload.length >= 1) {
        setInfoPair(String(dataPayload[0]), devInfoWheel, infoWheel);
      }
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0456 && p.ack) {
      if (dataPayload.length >= 1) {
        if (connectedAddress) {
          updateDeviceData(connectedAddress, { dcState: dataPayload[0] });
        }
        if (connectedAddress && connectedAddress === getActiveDeviceAddress()) {
          updateBatteryLabel();
        }
      }
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0401 && p.ack) {
      if (dataPayload.length >= 1) {
        if (connectedAddress) {
          updateDeviceData(connectedAddress, { volume: dataPayload[0] });
        }
        if (connectedAddress && connectedAddress === getActiveDeviceAddress()) {
          updateVolumeUI();
        }
      }
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0411 && p.ack) {
      if (dataPayload.length >= 6) {
        const lampOn = dataPayload[0] === 1;
        const lampBrightness = dataPayload[1];
        const type = dataPayload[2];
        const lampType = type >= 1 && type <= 5 ? type : 1;
        const [r, g, b] = dataPayload.slice(3, 6);
        const lampHue = rgbToSlider(r, g, b);
        if (connectedAddress) {
          updateDeviceData(connectedAddress, {
            lampOn,
            lampBrightness,
            lampType,
            lampHue,
            lampLastNonZero: lampBrightness > 0 ? lampBrightness : getDeviceData(connectedAddress).lampLastNonZero,
          });
        }
        if (connectedAddress && connectedAddress === getActiveDeviceAddress()) {
          updateLampUI();
        }
      }
    }
    const payloadText = p.payload.length
      ? p.payload.map((b: number) => toHex(b, 2)).join(" ")
      : "<empty>";
    const statusText = p.status !== null && p.status !== undefined ? ` status=${p.status}` : "";
    logLine(
      `${toHex(p.vendor_id, 4)} ${toHex(p.command_id, 4)}${p.ack ? " ACK" : ""}${statusText} ${payloadText}`,
      "IN"
    );
  });

  connectController
    ?.refreshDevices()
    .then(() => connectController?.syncBackendConnection())
    .catch((err) => logLine(String(err), "SYS"));
}
