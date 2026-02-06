import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";

type GaiaPacketEvent = {
  vendor_id: number;
  command_id: number;
  command: number;
  ack: boolean;
  flags: number;
  payload: number[];
  status?: number | null;
};

type DeviceInfo = {
  name: string;
  address: string;
  connected: boolean;
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
      <div class="app-header" data-tauri-drag-region>
        <div class="app-title">STONE 매니저</div>
      </div>

      <main class="layout">
        <header class="card">
          <div class="status-row">
            <div class="status" id="status">STONE이 연결되지 않음</div>
            <div class="battery" id="battery">배터리: --</div>
          </div>
        </header>

        <section>
          <h2>연결</h2>
          <div class="card">
            <div class="row">
              <button id="refreshDevices">새로고침</button>
              <select id="deviceList"></select>
              <label class="toggle">
                <input id="showAll" type="checkbox" checked />
                <span>모든 기기 보기</span>
              </label>
              <button id="connect">연결</button>
              <button id="disconnect">연결 끊기</button>
            </div>
          </div>
        </section>

        <section>
          <h2>GAIA 커맨드 전송</h2>
          <div class="card">
            <div class="grid">
              <label>
                벤더 ID (hex)
                <input id="vendorId" value="5054" />
              </label>
              <label>
                커맨드 ID (hex)
                <input id="commandId" value="0201" />
              </label>
              <label class="wide">
                페이로드 (hex)
                <input id="payload" placeholder="e.g. 1E or 0A0B0C" />
              </label>
            </div>
            <div class="row">
              <button id="send">전송</button>
            </div>
          </div>
        </section>

      </main>
    </div>
  `;

  const status = el<HTMLDivElement>("#status");
  const battery = el<HTMLDivElement>("#battery");
  const deviceList = el<HTMLSelectElement>("#deviceList");
  const showAll = el<HTMLInputElement>("#showAll");
  let devices: DeviceInfo[] = [];
  let lastBatteryStep: number | null = null;
  let lastDcState: number | null = null;
  let batteryTimer: ReturnType<typeof setInterval> | null = null;

  function logLine(line: string, tone: "IN" | "OUT" | "SYS" = "SYS") {
    void invoke("log_line", { line, tone, ts: "" });
  }

  function renderDeviceList() {
    deviceList.innerHTML = "";
    const filtered = showAll.checked ? devices : devices.filter((d) => d.connected);
    for (const device of filtered) {
      const opt = document.createElement("option");
      opt.value = device.address;
      const status = device.connected ? "connected" : "paired";
      opt.textContent = `${device.name} (${device.address}) · ${status}`;
      deviceList.appendChild(opt);
    }


    const preferred = filtered.find((d) => d.name.toUpperCase().includes("STONE"));
    if (preferred) {
      deviceList.value = preferred.address;
    }
  }

  async function refreshDevices() {
    devices = (await invoke<DeviceInfo[]>("list_devices")) ?? [];
    renderDeviceList();
  }

  async function connect() {
    const address = deviceList.value;
    if (!address) {
      logLine("Select a device first", "SYS");
      return;
    }
    try {
      await invoke("connect_device", { address });
      const device = devices.find((d) => d.address === address);
      status.textContent = device ? `Connected: ${device.name}` : `Connected: ${address}`;
      status.classList.add("connected");
      logLine(`Connected to ${device?.name ?? address}`, "SYS");
      await requestBattery();
      if (batteryTimer) clearInterval(batteryTimer);
      batteryTimer = setInterval(requestBattery, 30_000);
    } catch (err) {
      logLine(String(err), "SYS");
    }
  }

  async function disconnect() {
    try {
      await invoke("disconnect_device");
      status.textContent = "Disconnected";
      status.classList.remove("connected");
      battery.textContent = "배터리: --";
      lastBatteryStep = null;
      lastDcState = null;
      if (batteryTimer) {
        clearInterval(batteryTimer);
        batteryTimer = null;
      }
      logLine("Disconnected", "SYS");
    } catch (err) {
      logLine(String(err), "SYS");
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
    if (lastDcState === 1 && lastBatteryStep === 5) {
      suffix = " (충전 완료)";
    } else if (lastDcState === 3) {
      suffix = " (충전 중)";
    }
    battery.textContent = `배터리: ${percent}%${suffix}`;
  }

  async function sendCommand() {
    const vendorIdHex = el<HTMLInputElement>("#vendorId").value.trim();
    const commandIdHex = el<HTMLInputElement>("#commandId").value.trim();
    const payloadHex = el<HTMLInputElement>("#payload").value.trim();

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
  showAll.addEventListener("change", renderDeviceList);
  el<HTMLButtonElement>("#connect").addEventListener("click", connect);
  el<HTMLButtonElement>("#disconnect").addEventListener("click", disconnect);
  el<HTMLButtonElement>("#send").addEventListener("click", sendCommand);
  battery.addEventListener("click", requestBattery);

  listen<GaiaPacketEvent>("gaia_packet", (event: Event<GaiaPacketEvent>) => {
    const p = event.payload;
    const dataPayload = p.ack && p.payload.length > 0 ? p.payload.slice(1) : p.payload;
    if (p.vendor_id === 0x5054 && p.command === 0x0455 && p.ack) {
      if (dataPayload.length >= 1) {
        lastBatteryStep = dataPayload[0];
        updateBatteryLabel();
      }
    }
    if (p.vendor_id === 0x5054 && p.command === 0x0456 && p.ack) {
      if (dataPayload.length >= 1) {
        lastDcState = dataPayload[0];
        updateBatteryLabel();
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

  refreshDevices().catch((err) => logLine(String(err), "SYS"));
}
