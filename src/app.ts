import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen, type Event } from "@tauri-apps/api/event";
import { bindDevPage, renderDevPage } from "./dev";
import { bindSettingsPage, renderSettingsPage } from "./settings";
import { renderConnectPage } from "./connect";
import { renderLicensesPage } from "./licenses";
import { renderHeader } from "./components/header";
import { renderRange, updateRangeFill } from "./components/range";
import { renderToggle } from "./components/toggle";
import { renderListItem, renderList } from "./components/list";
import { renderSection } from "./components/section";
import { bindSelect, renderSelect } from "./components/select";
import { animate } from "motion";
import stoneImg from "./assets/stone.png";

type GaiaPacketEvent = {
  vendor_id: number;
  command_id: number;
  command: number;
  ack: boolean;
  flags: number;
  payload: number[];
  status?: number | null;
};

type ConnectResultEvent = {
  address: string;
  ok: boolean;
  error?: string | null;
};

type DeviceStateEvent = {
  address: string;
  connected: boolean;
};

type ConnectionInfo = {
  address: string;
  link: boolean;
  rfcomm: boolean;
};

type DeviceInfo = {
  name: string;
  address: string;
  connected: boolean;
  alias?: string | null;
  raw_name?: string | null;
};

type ConnectionState = "idle" | "connecting" | "connected" | "disconnecting";
type PairedDevice = {
  address: string;
  name: string;
};

const PAIRED_STORAGE_KEY = "stone_paired_devices";

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
        <div class="page home-shell" id="page-home" data-page="home">
          ${renderHeader({
            title: "STONE 매니저",
            titleId: "appTitle",
            showBack: false,
            showSidebarToggle: true,
            right: `
              <button class="nav-info" id="navSettings" data-tauri-drag-region="false">
                <span class="material-symbols-rounded">settings</span>
              </button>
            `,
          })}

          <aside class="sidebar" id="sidebar">
            <div class="sidebar-body">
              <button class="sidebar-item active" id="sidebar-1">
                <span class="material-symbols-rounded">speaker</span>
                <span>STONE White</span>
              </button>
              <button class="sidebar-item" id="sidebar-2">
                <span class="material-symbols-rounded">speaker</span>
                <span>STONE Black</span>
              </button>
            </div>
            <div class="sidebar-footer">
              <button class="sidebar-item" id="sidebar-pair">
                <span class="material-symbols-rounded">add</span>
                <span>새 기기 추가</span>
              </button>
            </div>
          </aside>

          <main class="layout">
            <section class="statusSection">
              <img src="${stoneImg}" class="device-image"/>
              <span class="status" id="status">STONE이 연결되지 않음</span>
              <div class="battery-container">
                <span class="material-symbols-rounded" id="batteryIcon">battery_android_question</span>
                <span class="battery" id="battery">--</span>
              </div>
            </section>

            ${renderSection({
              title: "소리",
              body: `
                <div class="card">
                  <div class="row volume-row">
                    ${renderRange({ id: "volumeSlider", min: 0, max: 30, step: 0.1, value: 0, icon: "volume_up" })}
                  </div>
                </div>
              `,
            })}
            ${renderSection({
              title: "램프",
              body: `
                ${renderList([
                  renderListItem({
                    label: "램프 사용",
                    right: renderToggle({ id: "lampToggle" }),
                  }),
                ])}
                ${renderList([
                  renderListItem({
                    label: "조명 밝기",
                    col: true,
                    body: renderRange({ id: "lampBrightness", min: 0, max: 100, step: 0.1, value: 0, className: "thumb-vertical" }),
                  }),
                  renderListItem({
                    label: "조명 색상",
                    right: renderSelect({
                      id: "lampType",
                      value: 1,
                      direction: "up",
                      options: [
                        { value: 1, label: "단일 색상" },
                        { value: 2, label: "촛불" },
                        { value: 3, label: "오로라" },
                        { value: 4, label: "파도" },
                        { value: 5, label: "반딧불" },
                      ],
                    }),
                    col: true,
                    body: renderRange({ id: "lampHue", min: 0, max: 360, step: 1, value: 0, className: "range-hue" }),
                  }),
                ])}
              `,
            })}

          </main>
        </div>
        ${renderConnectPage()}
        ${renderSettingsPage()}
        ${renderDevPage()}
        ${renderLicensesPage()}
      </div>
    </div>
  `;

  const navBackButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-back"));
  const navSidebarButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-sidebar"));
  const navSettings = el<HTMLButtonElement>("#navSettings");
  const sidebarPair = el<HTMLButtonElement>("#sidebar-pair");
  const homeShell = el<HTMLDivElement>("#page-home");
  const pageHost = el<HTMLDivElement>("#pageHost");
  const pageHome = el<HTMLDivElement>("#page-home");
  const pageDev = el<HTMLDivElement>("#page-dev");
  const pageSettings = el<HTMLDivElement>("#page-settings");
  const pageConnect = el<HTMLDivElement>("#page-connect");
  const pageLicenses = el<HTMLDivElement>("#page-licenses");
  const status = el<HTMLDivElement>("#status");
  const battery = el<HTMLDivElement>("#battery");
  const batteryIcon = el<HTMLSpanElement>("#batteryIcon");
  const volumeSlider = el<HTMLInputElement>("#volumeSlider");
  const lampToggle = el<HTMLInputElement>("#lampToggle");
  const lampBrightness = el<HTMLInputElement>("#lampBrightness");
  const lampHue = el<HTMLInputElement>("#lampHue");
  let registerSelected = "";
  let registeredSelected = "";
  const registerButton = el<HTMLButtonElement>("#registerDevice");
  const removeButton = el<HTMLButtonElement>("#removeRegistered");
  let devices: DeviceInfo[] = [];
  let pairedDevices = loadPairedDevices();
  let connectionState: ConnectionState = "idle";
  let connectedAddress: string | null = null;
  let registerPending: string | null = null;
  let lastBatteryStep: number | null = null;
  let lastDcState: number | null = null;
  let batteryTimer: ReturnType<typeof setInterval> | null = null;
  let volumeDebounce: ReturnType<typeof setTimeout> | null = null;
  let lampBrightnessState: number | null = null;
  let lampTypeState = 1;
  let lampHueState = 0;
  let lampDebounce: ReturnType<typeof setTimeout> | null = null;
  let lampLastNonZero = 50;
  let lampOnState = false;

  let currentPage: "home" | "dev" | "settings" | "connect" | "licenses" = "home";
  let isTransitioning = false;
  const pageHistory: Array<"home" | "dev" | "settings" | "connect" | "licenses"> = [];

  pageHome.style.filter = "brightness(1)";
  pageDev.style.zIndex = "0";
  pageHome.style.zIndex = "1";
  animate(pageHome, { x: "0%" }, { duration: 0 });
  animate(pageDev, { x: "100%" }, { duration: 0 });
  animate(pageSettings, { x: "100%" }, { duration: 0 });
  animate(pageConnect, { x: "100%" }, { duration: 0 });
  animate(pageLicenses, { x: "100%" }, { duration: 0 });
  function resetPageStack() {
    pageHome.style.zIndex = "0";
    pageDev.style.zIndex = "0";
    pageSettings.style.zIndex = "0";
    pageConnect.style.zIndex = "0";
    pageLicenses.style.zIndex = "0";
  }

  async function navigate(
    to: "home" | "dev" | "settings" | "connect" | "licenses",
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
          : to === "connect"
            ? pageConnect
            : to === "licenses"
              ? pageLicenses
              : pageHome;
    const leave =
      currentPage === "dev"
        ? pageDev
        : currentPage === "settings"
          ? pageSettings
          : currentPage === "connect"
            ? pageConnect
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

  function goTo(to: "home" | "dev" | "settings" | "connect" | "licenses") {
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


  function getDeviceLabel(address: string) {
    const device = devices.find((d) => d.address === address);
    if (device?.name) return device.name;
    const paired = pairedDevices.find((d) => d.address === address);
    return paired?.name ?? address;
  }

  function loadPairedDevices(): PairedDevice[] {
    try {
      const raw = localStorage.getItem(PAIRED_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry) => entry && typeof entry.address === "string")
        .map((entry) => ({
          address: entry.address,
          name: typeof entry.name === "string" ? entry.name : entry.address,
        }));
    } catch {
      return [];
    }
  }

  function savePairedDevices(list: PairedDevice[]) {
    localStorage.setItem(PAIRED_STORAGE_KEY, JSON.stringify(list));
  }

  function upsertPairedDevice(address: string) {
    if (!address) return;
    const latestName = devices.find((d) => d.address === address)?.name ?? address;
    const existing = pairedDevices.findIndex((d) => d.address === address);
    if (existing >= 0) {
      pairedDevices[existing].name = latestName;
    } else {
      pairedDevices.unshift({ address, name: latestName });
    }
    savePairedDevices(pairedDevices);
    renderRegisteredList();
  }

  function stopBatteryPolling() {
    if (batteryTimer) {
      clearInterval(batteryTimer);
      batteryTimer = null;
    }
  }

  function resetBatteryState() {
    battery.textContent = "--";
    batteryIcon.textContent = "battery_android_question";
    lastBatteryStep = null;
    lastDcState = null;
    void invoke("set_tray_battery", { percent: null, charging: false, full: false });
  }

  const lampTypeSelect = bindSelect("lampType", (value) => {
    const next = Number(value);
    lampTypeState = next;
    if (!lampOnState) return;
    setLampType(next).catch((err) => logLine(String(err), "SYS"));
    if (next === 1) {
      setLampColor(lampHueState).catch((err) => logLine(String(err), "SYS"));
    }
  });

  const registerListSelect = bindSelect("registerList", (value) => {
    registerSelected = value;
  });

  const registeredListSelect = bindSelect("registeredList", (value) => {
    registeredSelected = value;
  });

  function setLampEnabled(enabled: boolean) {
    lampToggle.disabled = !enabled;
    lampBrightness.disabled = !enabled;
    lampHue.disabled = !enabled;
    lampTypeSelect?.setEnabled(enabled);
  }

  function updateLampUI() {
    if (lampBrightnessState === null) {
      lampBrightness.value = "0";
    } else {
      lampBrightness.value = String(lampBrightnessState);
    }
    updateRangeFill(lampBrightness);
    lampToggle.checked = lampOnState;
    lampTypeSelect?.setValue(lampTypeState);
    lampHue.value = String(lampHueState);
    updateRangeFill(lampHue);
    setLampEnabled(connectionState === "connected");
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

  function setVolumeEnabled(enabled: boolean) {
    volumeSlider.disabled = !enabled;
  }

  function updateVolumeUI(value: number | null) {
    const v = (value === null || Number.isNaN(value)) ? 0 : value;
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
    requestBattery().catch((err) => logLine(String(err), "SYS"));
    requestVolume().catch((err) => logLine(String(err), "SYS"));
    requestLampState().catch((err) => logLine(String(err), "SYS"));
    stopBatteryPolling();
    batteryTimer = setInterval(requestBattery, 30_000);
    setVolumeEnabled(true);
    setLampEnabled(true);
  }

  function setDisconnected() {
    stopBatteryPolling();
    resetBatteryState();
    updateVolumeUI(null);
    setVolumeEnabled(false);
    lampBrightnessState = null;
    lampOnState = false;
    updateLampUI();
    setConnectionState("idle", null);
  }

  function updateConnectionStatus() {
    switch (connectionState) {
      case "connecting":
        status.textContent = "연결 중...";
        status.classList.remove("connected");
        break;
      case "disconnecting":
        status.textContent = "연결 해제 중...";
        status.classList.remove("connected");
        break;
      case "connected": {
        const label = connectedAddress ? getDeviceLabel(connectedAddress) : "Unknown";
        status.textContent = `${label}`;
        status.classList.add("connected");
        break;
      }
      case "idle":
      default:
        status.textContent = "STONE이 연결되지 않음";
        status.classList.remove("connected");
        break;
    }
  }

  function setConnectionState(state: ConnectionState, address: string | null = connectedAddress) {
    connectionState = state;
    connectedAddress = address;
    updateConnectionStatus();
  }

  function renderRegisterList() {
    const previous = registerSelected;
    const connectedDevices = devices.filter((d) => d.connected);
    if (connectedDevices.length === 0) {
      registerSelected = "";
      registerListSelect?.setOptions([{ value: "", label: "연결된 기기가 없습니다." }], "");
      registerListSelect?.setEnabled(false);
      return;
    }

    registerListSelect?.setEnabled(true);
    const options = connectedDevices.map((device) => {
      const alias = device.alias ?? "";
      const raw = device.raw_name ?? "";
      const label = alias && raw && alias !== raw ? `${alias} (name: ${raw})` : device.name;
      return { value: device.address, label: `${label} (${device.address})` };
    });
    if (previous && connectedDevices.some((d) => d.address === previous)) {
      registerSelected = previous;
      registerListSelect?.setOptions(options, previous);
      return;
    }
    const preferred = connectedDevices.find((d) => d.name.toUpperCase().includes("STONE"));
    if (preferred) {
      registerSelected = preferred.address;
      registerListSelect?.setOptions(options, preferred.address);
      return;
    }
    if (connectedDevices[0]) {
      registerSelected = connectedDevices[0].address;
      registerListSelect?.setOptions(options, connectedDevices[0].address);
    }
  }

  function renderRegisteredList() {
    const previous = registeredSelected;
    if (pairedDevices.length === 0) {
      registeredSelected = "";
      registeredListSelect?.setOptions([{ value: "", label: "등록된 기기가 없습니다." }], "");
      registeredListSelect?.setEnabled(false);
      return;
    }

    registeredListSelect?.setEnabled(true);
    const options = pairedDevices.map((paired) => {
      const device = devices.find((d) => d.address === paired.address);
      const status = device?.connected ? "connected" : device ? "paired" : "saved";
      const name = device?.name ?? paired.name ?? paired.address;
      return { value: paired.address, label: `${name} (${paired.address}) · ${status}` };
    });

    if (previous && pairedDevices.some((d) => d.address === previous)) {
      registeredSelected = previous;
      registeredListSelect?.setOptions(options, previous);
      return;
    }
    if (connectedAddress && pairedDevices.some((d) => d.address === connectedAddress)) {
      registeredSelected = connectedAddress;
      registeredListSelect?.setOptions(options, connectedAddress);
      return;
    }
    if (pairedDevices[0]) {
      registeredSelected = pairedDevices[0].address;
      registeredListSelect?.setOptions(options, pairedDevices[0].address);
    }
  }

  function removePairedDevice(address: string) {
    if (!address) return;
    pairedDevices = pairedDevices.filter((d) => d.address !== address);
    savePairedDevices(pairedDevices);
    renderRegisteredList();
  }

  async function refreshDevices() {
    devices = (await invoke<DeviceInfo[]>("list_devices")) ?? [];
    renderRegisterList();
    renderRegisteredList();
  }

  async function syncBackendConnection() {
    try {
      const info = await invoke<ConnectionInfo>("get_connection_info");
      if (info.rfcomm && info.address) {
        setConnected(info.address);
        upsertPairedDevice(info.address);
      } else if (connectionState === "connected") {
        setDisconnected();
      }
    } catch (err) {
      logLine(String(err), "SYS");
    }
  }

  async function connect() {
    const address = registeredSelected;
    if (!address) {
      logLine("Select a device first", "SYS");
      return;
    }
    if (connectionState === "connecting" || connectionState === "disconnecting") {
      logLine("Connect already in progress", "SYS");
      return;
    }
    if (connectionState === "connected" && connectedAddress === address) {
      logLine("Already connected", "SYS");
      return;
    }
    try {
      setConnectionState("connecting", address);
      await invoke("connect_device_async", { address });
    } catch (err) {
      logLine(String(err), "SYS");
      setConnectionState("idle", null);
    }
  }

  async function registerDevice() {
    const address = registerSelected;
    if (!address) {
      logLine("Select a device to register", "SYS");
      return;
    }
    if (connectionState === "connecting" || connectionState === "disconnecting") {
      logLine("Connect already in progress", "SYS");
      return;
    }
    if (connectionState === "connected" && connectedAddress === address) {
      upsertPairedDevice(address);
      logLine(`Registered ${getDeviceLabel(address)}`, "SYS");
      return;
    }
    try {
      registerPending = address;
      setConnectionState("connecting", address);
      await invoke("connect_device_async", { address });
    } catch (err) {
      registerPending = null;
      logLine(String(err), "SYS");
      setConnectionState("idle", null);
    }
  }

  async function disconnect() {
    try {
      setConnectionState("disconnecting", connectedAddress);
      await invoke("disconnect_device");
      setDisconnected();
      logLine("Disconnected", "SYS");
    } catch (err) {
      logLine(String(err), "SYS");
      setConnectionState("idle", connectedAddress);
    }
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
    if (lastBatteryStep === null) {
      battery.textContent = "--";
      batteryIcon.textContent = "battery_android_question";
      void invoke("set_tray_battery", { percent: null, charging: false, full: false });
      return;
    }
    let percent: number;
    switch (lastBatteryStep) {
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
        percent = lastBatteryStep;
        break;
    }
    let suffix = "";
    const isFull = lastDcState === 1 && lastBatteryStep === 5;
    const isCharging = lastDcState === 3;
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

  el<HTMLButtonElement>("#refreshDevices").addEventListener("click", refreshDevices);
  el<HTMLButtonElement>("#connect").addEventListener("click", connect);
  el<HTMLButtonElement>("#disconnect").addEventListener("click", disconnect);
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

  bindDevPage({
    onSend: sendCommand,
  });
  loadAppVersion().catch(() => {});
  battery.addEventListener("click", requestBattery);
  setVolumeEnabled(false);
  updateVolumeUI(null);
  updateLampUI();
  volumeSlider.addEventListener("input", () => {
    if (volumeSlider.disabled) return;
    const value = Number(volumeSlider.value);
    updateVolumeUI(value);
    if (volumeDebounce) {
      clearTimeout(volumeDebounce);
    }
    volumeDebounce = setTimeout(() => {
      setVolume(value);
    }, 150);
  });
  lampToggle.addEventListener("change", () => {
    if (lampToggle.disabled) return;
    const current = lampBrightnessState ?? 0;
    const nextValue = lampToggle.checked
      ? (current > 0 ? current : lampLastNonZero)
      : 0;
    lampBrightnessState = nextValue;
    if (nextValue > 0) {
      lampLastNonZero = nextValue;
    }
    lampOnState = lampToggle.checked;
    updateLampUI();
    if (lampOnState) {
      runLamp(nextValue, lampTypeState, lampHueState).catch((err) => logLine(String(err), "SYS"));
    } else {
      stopLamp().catch((err) => logLine(String(err), "SYS"));
    }
  });
  lampBrightness.addEventListener("input", () => {
    if (lampBrightness.disabled) return;
    const value = Number(lampBrightness.value);
    lampBrightnessState = value;
    if (value > 0) {
      lampLastNonZero = value;
    }
    updateLampUI();
    if (lampDebounce) {
      clearTimeout(lampDebounce);
    }
    lampDebounce = setTimeout(() => {
      if (!lampOnState) return;
      setLampBrightness(value).catch((err) => logLine(String(err), "SYS"));
    }, 150);
    updateRangeFill(lampBrightness);
  });
  lampHue.addEventListener("input", () => {
    if (lampHue.disabled) return;
    lampHueState = Number(lampHue.value);
    updateRangeFill(lampHue);
    if (!lampOnState) return;
    if (lampTypeState === 1) {
      setLampColor(lampHueState).catch((err) => logLine(String(err), "SYS"));
    }
  });
  registerButton.addEventListener("click", registerDevice);
  bindSettingsPage(() => {
    logLine("Developer menu unlocked", "SYS");
    goTo("dev");
  });
  navSettings.addEventListener("click", () => {
    goTo("settings");
  });
  sidebarPair.addEventListener("click", () => {
    goTo("connect");
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
  removeButton.addEventListener("click", () => {
    const address = registeredSelected;
    if (!address) {
      logLine("Select a device to remove", "SYS");
      return;
    }
    removePairedDevice(address);
    logLine(`Removed ${getDeviceLabel(address)}`, "SYS");
  });

  listen<ConnectResultEvent>("bt_connect_result", (event: Event<ConnectResultEvent>) => {
    const result = event.payload;
    const device = devices.find((d) => d.address === result.address);
    if (result.ok) {
      setConnected(result.address);
      upsertPairedDevice(result.address);
      if (registerPending === result.address) {
        logLine(`Registered ${device?.name ?? result.address}`, "SYS");
        registerPending = null;
      }
      logLine(`Connected to ${device?.name ?? result.address}`, "SYS");
    } else {
      if (registerPending === result.address) {
        logLine(result.error ?? "Register failed", "SYS");
        registerPending = null;
      }
      if (connectedAddress === result.address) {
        setDisconnected();
      } else {
        setConnectionState("idle", connectedAddress);
      }
      logLine(result.error ?? "Connect failed", "SYS");
    }
  });

  listen<DeviceStateEvent>("bt_device_event", (event: Event<DeviceStateEvent>) => {
    const { address, connected } = event.payload;
    const target = devices.find((d) => d.address === address);
    if (target) {
      target.connected = connected;
      renderRegisterList();
      renderRegisteredList();
    } else {
      refreshDevices().catch((err) => logLine(String(err), "SYS"));
    }
    if (connectedAddress === address && !connected) {
      if (connectionState === "connecting") {
        return;
      }
      setDisconnected();
    }
  });

  listen<GaiaPacketEvent>("gaia_packet", (event: Event<GaiaPacketEvent>) => {
    const p = event.payload;
    const dataPayload = p.ack && p.payload.length > 0 ? p.payload.slice(1) : p.payload;
    if (p.vendor_id === 0x5054 && p.command === 0x0455 && p.ack) {
      if (dataPayload.length >= 1) {
        lastBatteryStep = dataPayload[0];
        updateBatteryLabel();
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
        lastDcState = dataPayload[0];
        updateBatteryLabel();
      }
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0401 && p.ack) {
      if (dataPayload.length >= 1) {
        updateVolumeUI(dataPayload[0]);
      }
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0411 && p.ack) {
      if (dataPayload.length >= 6) {
        lampOnState = dataPayload[0] === 1;
        lampBrightnessState = dataPayload[1];
        const type = dataPayload[2];
        lampTypeState = type >= 1 && type <= 5 ? type : 1;
        const [r, g, b] = dataPayload.slice(3, 6);
        lampHueState = rgbToSlider(r, g, b);
        if (lampBrightnessState > 0) {
          lampLastNonZero = lampBrightnessState;
        }
        updateLampUI();
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

  refreshDevices()
    .then(syncBackendConnection)
    .catch((err) => logLine(String(err), "SYS"));
}
