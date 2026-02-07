import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import { bindDevPage, renderDevPage } from "./dev";

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
      <div class="app-header" data-tauri-drag-region>
        <button class="nav-back" id="navBack" data-tauri-drag-region="false">뒤로</button>
        <div class="app-title" id="appTitle" data-tauri-drag-region="false">STONE 매니저</div>
        <div class="header-spacer"></div>
      </div>

      <main class="layout" id="mainPage">
        <header class="card">
          <div class="status-row">
            <div class="status" id="status">STONE이 연결되지 않음</div>
            <div class="battery" id="battery">배터리: --</div>
          </div>
        </header>

        <section>
          <h2>소리</h2>
          <div class="card">
            <div class="row volume-row">
              <input id="volumeSlider" type="range" min="0" max="30" step="1" value="0" />
              <div class="volume-value" id="volumeValue">--</div>
            </div>
          </div>
        </section>

                <section>
          <h2>램프</h2>
          <div class="card">
            <div class="grid">
              <label class="wide">
                램프 사용
                <input id="lampToggle" type="checkbox" />
              </label>
              <label class="wide">
                조명 밝기 <span id="lampBrightnessValue">--</span>
                <input id="lampBrightness" type="range" min="0" max="100" step="1" value="0" />
              </label>
              <label>
                조명 종류
                <select id="lampType">
                  <option value="1">단색</option>
                  <option value="2">촛불</option>
                  <option value="3">오로라</option>
                  <option value="4">파도</option>
                  <option value="5">반딧불</option>
                </select>
              </label>
              <label>
                색상
                <input id="lampColor" type="color" value="#ffffff" />
              </label>
            </div>
          </div>
        </section>

        <section>
          <h2>기기 등록</h2>
          <div class="card">
            <div class="row">
              <select id="registerList"></select>
              <button id="registerDevice">등록</button>
            </div>
          </div>
        </section>

        <section>
          <h2>연결</h2>
          <div class="card">
            <div class="row">
              <button id="refreshDevices">새로고침</button>
              <select id="registeredList"></select>
              <button id="connect">연결</button>
              <button id="disconnect">연결 끊기</button>
              <button id="removeRegistered">삭제</button>
            </div>
          </div>
        </section>

      </main>
      ${renderDevPage()}
    </div>
  `;

  const appTitle = el<HTMLDivElement>("#appTitle");
  const navBack = el<HTMLButtonElement>("#navBack");
  const status = el<HTMLDivElement>("#status");
  const battery = el<HTMLDivElement>("#battery");
  const volumeSlider = el<HTMLInputElement>("#volumeSlider");
  const volumeValue = el<HTMLDivElement>("#volumeValue");
  const lampToggle = el<HTMLInputElement>("#lampToggle");
  const lampBrightness = el<HTMLInputElement>("#lampBrightness");
  const lampBrightnessValue = el<HTMLSpanElement>("#lampBrightnessValue");
  const lampType = el<HTMLSelectElement>("#lampType");
  const lampColor = el<HTMLInputElement>("#lampColor");
  const registerList = el<HTMLSelectElement>("#registerList");
  const registeredList = el<HTMLSelectElement>("#registeredList");
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
  let volumeValueState: number | null = null;
  let volumeDebounce: ReturnType<typeof setTimeout> | null = null;
  let lampBrightnessState: number | null = null;
  let lampTypeState = 1;
  let lampColorState = "#ffffff";
  let lampDebounce: ReturnType<typeof setTimeout> | null = null;
  let lampLastNonZero = 50;
  let lampOnState = false;
  let devEnabled = false;
  let devClicks = 0;
  let devClickTimer: ReturnType<typeof setTimeout> | null = null;

  function setPage(page: "home" | "dev") {
    document.body.dataset.page = page;
    appTitle.textContent = page === "dev" ? "개발자 메뉴" : "STONE 매니저";
    if (page === "dev") {
      requestAllDeviceInfo();
    }
  }

  setPage("home");

  function logLine(line: string, tone: "IN" | "OUT" | "SYS" = "SYS") {
    void invoke("log_line", { line, tone, ts: "" });
  }

  function onDevClick() {
    devClicks += 1;
    if (devClickTimer) {
      clearTimeout(devClickTimer);
    }
    devClickTimer = setTimeout(() => {
      devClicks = 0;
    }, 1500);
    if (devClicks >= 7) {
      devClicks = 0;
      devEnabled = true;
      logLine("Developer menu unlocked", "SYS");
      setPage("dev");
    }
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
    battery.textContent = "배터리: --";
    lastBatteryStep = null;
    lastDcState = null;
    void invoke("set_tray_battery", { percent: null, charging: false, full: false });
  }

  function setLampEnabled(enabled: boolean) {
    lampToggle.disabled = !enabled;
    lampBrightness.disabled = !enabled;
    lampType.disabled = !enabled;
    lampColor.disabled = !enabled;
  }

  function updateLampUI() {
    if (lampBrightnessState === null) {
      lampBrightnessValue.textContent = "--";
      lampBrightness.value = "0";
    } else {
      lampBrightnessValue.textContent = String(lampBrightnessState);
      lampBrightness.value = String(lampBrightnessState);
    }
    lampToggle.checked = lampOnState;
    lampType.value = String(lampTypeState);
    lampColor.value = lampColorState;
    setLampEnabled(connectionState === "connected");
  }

  function parseColorHex(hex: string) {
    const value = hex.replace("#", "");
    if (value.length !== 6) return [255, 255, 255];
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return [r, g, b];
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
    await invoke("send_gaia_command", { vendorId: 0x5054, commandId: 0x0202, payload: [value] });
  }

  async function setLampType(value: number) {
    await invoke("send_gaia_command", { vendorId: 0x5054, commandId: 0x0203, payload: [value] });
  }

  async function setLampColor(value: string) {
    const [r, g, b] = parseColorHex(value);
    await invoke("send_gaia_command", { vendorId: 0x5054, commandId: 0x0204, payload: [r, g, b] });
  }

  async function runLamp(mood: number, type: number, color: string) {
    const [r, g, b] = parseColorHex(color);
    await invoke("send_gaia_command", {
      vendorId: 0x5054,
      commandId: 0x0212,
      payload: [mood, type, r, g, b],
    });
  }

  async function stopLamp() {
    await invoke("send_gaia_command", { vendorId: 0x5054, commandId: 0x0213, payload: [] });
  }

  function setVolumeEnabled(enabled: boolean) {
    volumeSlider.disabled = !enabled;
  }

  function updateVolumeUI(value: number | null) {
    if (value === null || Number.isNaN(value)) {
      volumeValueState = null;
      volumeValue.textContent = "--";
      volumeSlider.value = "0";
      return;
    }
    volumeValueState = value;
    volumeSlider.value = String(value);
    volumeValue.textContent = String(value);
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
      await invoke("send_gaia_command", { vendorId: 0x5054, commandId: 0x0201, payload: [value] });
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
        status.textContent = `연결됨: ${label}`;
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
    const previous = registerList.value;
    registerList.innerHTML = "";
    const connectedDevices = devices.filter((d) => d.connected);
    if (connectedDevices.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "연결된 기기가 없습니다.";
      opt.disabled = true;
      opt.selected = true;
      registerList.appendChild(opt);
      return;
    }

    for (const device of connectedDevices) {
      const opt = document.createElement("option");
      opt.value = device.address;
      const alias = device.alias ?? "";
      const raw = device.raw_name ?? "";
      const label =
        alias && raw && alias !== raw
          ? `${alias} (name: ${raw})`
          : device.name;
      opt.textContent = `${label} (${device.address})`;
      registerList.appendChild(opt);
    }

    if (previous && connectedDevices.some((d) => d.address === previous)) {
      registerList.value = previous;
      return;
    }
    const preferred = connectedDevices.find((d) => d.name.toUpperCase().includes("STONE"));
    if (preferred) {
      registerList.value = preferred.address;
    } else if (connectedDevices[0]) {
      registerList.value = connectedDevices[0].address;
    }
  }

  function renderRegisteredList() {
    const previous = registeredList.value;
    registeredList.innerHTML = "";
    if (pairedDevices.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "등록된 기기가 없습니다.";
      opt.disabled = true;
      opt.selected = true;
      registeredList.appendChild(opt);
      return;
    }

    for (const paired of pairedDevices) {
      const device = devices.find((d) => d.address === paired.address);
      const status = device?.connected ? "connected" : device ? "paired" : "saved";
      const name = device?.name ?? paired.name ?? paired.address;
      const opt = document.createElement("option");
      opt.value = paired.address;
      opt.textContent = `${name} (${paired.address}) · ${status}`;
      registeredList.appendChild(opt);
    }

    if (previous && pairedDevices.some((d) => d.address === previous)) {
      registeredList.value = previous;
      return;
    }
    if (connectedAddress && pairedDevices.some((d) => d.address === connectedAddress)) {
      registeredList.value = connectedAddress;
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
    const address = registeredList.value;
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
    const address = registerList.value;
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
      battery.textContent = "배터리: --";
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
    if (isFull) {
      suffix = " (충전 완료)";
    } else if (isCharging) {
      suffix = " (충전 중)";
    }
    battery.textContent = `배터리: ${percent}%${suffix}`;
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

  function setDevInfo(target: HTMLDivElement | null, value: string) {
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
      runLamp(nextValue, lampTypeState, lampColorState).catch((err) => logLine(String(err), "SYS"));
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
  });
  lampType.addEventListener("change", () => {
    if (lampType.disabled) return;
    const value = Number(lampType.value);
    lampTypeState = value;
    if (!lampOnState) return;
    setLampType(value).catch((err) => logLine(String(err), "SYS"));
    if (value === 1) {
      setLampColor(lampColorState).catch((err) => logLine(String(err), "SYS"));
    }
  });
  lampColor.addEventListener("input", () => {
    if (lampColor.disabled) return;
    lampColorState = lampColor.value;
    if (!lampOnState) return;
    if (lampTypeState === 1) {
      setLampColor(lampColorState).catch((err) => logLine(String(err), "SYS"));
    }
  });
  registerButton.addEventListener("click", registerDevice);
  appTitle.addEventListener("click", onDevClick);
  navBack.addEventListener("click", () => {
    setPage("home");
  });
  removeButton.addEventListener("click", () => {
    const address = registeredList.value;
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
      if (name) setDevInfo(devInfoName, name);
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0452 && p.ack) {
      const firmware = new TextDecoder().decode(new Uint8Array(dataPayload)).trim();
      if (firmware) setDevInfo(devInfoFirmware, firmware);
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0453 && p.ack) {
      const mac = new TextDecoder().decode(new Uint8Array(dataPayload)).trim();
      if (mac) setDevInfo(devInfoMac, mac);
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0454 && p.ack) {
      if (dataPayload.length >= 1) {
        const rssi = (dataPayload[0] & 0x80) ? dataPayload[0] - 256 : dataPayload[0];
        setDevInfo(devInfoRssi, `${rssi} dBm`);
      }
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0457 && p.ack) {
      if (dataPayload.length >= 1) {
        setDevInfo(devInfoWheel, String(dataPayload[0]));
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
        lampColorState = `#${toHex(r, 2)}${toHex(g, 2)}${toHex(b, 2)}`;
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
