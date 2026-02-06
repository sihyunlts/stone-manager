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
    <main class="layout">
      <header class="card">
        <div>
          <h1>STONE 매니저</h1>
        </div>
        <div class="status" id="status">STONE이 연결되지 않음</div>
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

      <section>
        <h2>로그</h2>
        <div class="card log">
          <div id="log"></div>
        </div>
      </section>
    </main>
  `;

  const status = el<HTMLDivElement>("#status");
  const deviceList = el<HTMLSelectElement>("#deviceList");
  const log = el<HTMLDivElement>("#log");
  const showAll = el<HTMLInputElement>("#showAll");
  let devices: DeviceInfo[] = [];

  function logLine(line: string, tone: "in" | "out" | "sys" = "sys") {
    const div = document.createElement("div");
    div.className = `log-line ${tone}`;
    div.textContent = line;
    log.prepend(div);
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
      logLine("Select a device first", "sys");
      return;
    }
    try {
      await invoke("connect_device", { address });
      const device = devices.find((d) => d.address === address);
      status.textContent = device ? `Connected: ${device.name}` : `Connected: ${address}`;
      status.classList.add("connected");
      logLine(`Connected to ${device?.name ?? address}`, "sys");
    } catch (err) {
      logLine(String(err), "sys");
    }
  }

  async function disconnect() {
    try {
      await invoke("disconnect_device");
      status.textContent = "Disconnected";
      status.classList.remove("connected");
      logLine("Disconnected", "sys");
    } catch (err) {
      logLine(String(err), "sys");
    }
  }

  async function sendCommand() {
    const vendorIdHex = el<HTMLInputElement>("#vendorId").value.trim();
    const commandIdHex = el<HTMLInputElement>("#commandId").value.trim();
    const payloadHex = el<HTMLInputElement>("#payload").value.trim();

    const vendorId = parseInt(vendorIdHex, 16);
    const commandId = parseInt(commandIdHex, 16);
    if (Number.isNaN(vendorId) || Number.isNaN(commandId)) {
      logLine("Invalid vendor or command id", "sys");
      return;
    }

    let payload: number[] = [];
    try {
      payload = parseHexBytes(payloadHex);
    } catch (err) {
      logLine(String(err), "sys");
      return;
    }

    try {
      await invoke("send_gaia_command", { vendorId, commandId, payload });
      const payloadText = payload.length
        ? payload.map((b) => toHex(b, 2)).join(" ")
        : "<empty>";
      logLine(`→ ${toHex(vendorId, 4)} ${toHex(commandId, 4)} ${payloadText}`, "out");
    } catch (err) {
      logLine(String(err), "sys");
    }
  }

  el<HTMLButtonElement>("#refreshDevices").addEventListener("click", refreshDevices);
  showAll.addEventListener("change", renderDeviceList);
  el<HTMLButtonElement>("#connect").addEventListener("click", connect);
  el<HTMLButtonElement>("#disconnect").addEventListener("click", disconnect);
  el<HTMLButtonElement>("#send").addEventListener("click", sendCommand);

  listen<GaiaPacketEvent>("gaia_packet", (event: Event<GaiaPacketEvent>) => {
    const p = event.payload;
    const payloadText = p.payload.length
      ? p.payload.map((b: number) => toHex(b, 2)).join(" ")
      : "<empty>";
    const statusText = p.status !== null && p.status !== undefined ? ` status=${p.status}` : "";
    logLine(
      `← ${toHex(p.vendor_id, 4)} ${toHex(p.command_id, 4)}${p.ack ? " ACK" : ""}${statusText} ${payloadText}`,
      "in"
    );
  });

  refreshDevices().catch((err) => logLine(String(err), "sys"));
}
