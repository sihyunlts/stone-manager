import { renderHeader } from "../components/header";
import { renderSection } from "../components/section";
import { renderList, renderListItem } from "../components/list";
import type { DeviceInfo } from "../services/bluetooth";

export function renderAddDevicePage() {
  const addSection = renderSection({
    title: "나의 기기",
    body: `
      <div id="pairList">
        ${renderList([
          renderListItem({
            label: "연결된 기기가 없습니다.",
            value: "",
            className: "device-item-empty",
          }),
        ])}
      </div>
      <div class="row">
        <button id="pairDevice">기기 추가</button>
      </div>
    `,
  });
  const unpairedSection = renderSection({
    title: "검색된 기기",
    body: `
      <div id="unpairedStoneList">
        ${renderList([
          renderListItem({
            label: "표시할 기기가 없습니다.",
            value: "",
            className: "device-item-empty",
          }),
        ])}
      </div>
    `,
  });

  return `
    <div class="page" id="page-pairing" data-page="pairing">
      ${renderHeader({ title: "기기 추가", showBack: true })}
      <main class="layout">
        ${addSection}
        ${unpairedSection}
      </main>
    </div>
  `;
}

type AddDeviceHandlers = {
  getDevices: () => DeviceInfo[];
  refreshDevices: () => Promise<DeviceInfo[]>;
  scanUnpairedStoneDevices: () => Promise<DeviceInfo[]>;
  onPair: (address: string) => void | Promise<void>;
  logLine: (line: string, tone?: "IN" | "OUT" | "SYS") => void;
};

export function initAddDevicePage(handlers: AddDeviceHandlers) {
  const pairList = document.querySelector<HTMLDivElement>("#pairList");
  const unpairedStoneList = document.querySelector<HTMLDivElement>("#unpairedStoneList");
  const pairButton = document.querySelector<HTMLButtonElement>("#pairDevice");
  let selected = "";
  let cachedUnpairedStoneDevices: DeviceInfo[] = [];
  let scanTimer: number | null = null;
  let refreshInFlight = false;

  function select(address: string) {
    selected = address;
    pairList?.querySelectorAll(".device-item").forEach((item) => {
      item.classList.toggle("is-selected", item.getAttribute("data-address") === address);
    });
  }

  function render(devices: DeviceInfo[]) {
    const connectedDevices = devices.filter((d) => d.paired && d.connected && d.has_gaia);
    const unpairedStoneDevices = cachedUnpairedStoneDevices;

    if (pairList) {
      if (connectedDevices.length === 0) {
        if (!selected || !unpairedStoneDevices.some(d => d.address === selected)) {
          selected = "";
        }
        pairList.innerHTML = renderList([
          renderListItem({
            label: "연결된 기기가 없습니다.",
            value: "",
            className: "device-item-empty",
          }),
        ]);
      } else {
        pairList.innerHTML = renderList(
          connectedDevices.map((device) =>
            renderListItem({
              label: device.name ?? device.address,
              className: "device-item",
              data: { address: device.address },
            })
          )
        );
      }
    }

    if (unpairedStoneList) {
      if (unpairedStoneDevices.length === 0) {
        unpairedStoneList.innerHTML = renderList([
          renderListItem({
            label: refreshInFlight ? "STONE 기기 검색 중..." : "표시할 기기가 없습니다.",
            value: "",
            className: "device-item-empty",
          }),
        ]);
      } else {
        unpairedStoneList.innerHTML = renderList(
          unpairedStoneDevices.map((device) =>
            renderListItem({
              label: device.name ?? device.address,
              className: "device-item",
              data: { address: device.address },
            })
          )
        );
      }
    }

    if (selected) {
      select(selected);
    } else if (connectedDevices[0]) {
      select(connectedDevices[0].address);
    }
  }

  async function refresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    render(handlers.getDevices());
    try {
      const devices = await handlers.refreshDevices();
      const unpairedStoneDevices = await handlers.scanUnpairedStoneDevices();
      cachedUnpairedStoneDevices = unpairedStoneDevices;
      render(devices);
    } catch (err) {
      handlers.logLine(String(err), "SYS");
    } finally {
      refreshInFlight = false;
      render(handlers.getDevices());
    }
  }

  function stopAutoScan() {
    if (scanTimer !== null) {
      window.clearInterval(scanTimer);
      scanTimer = null;
    }
  }

  function startAutoScan() {
    stopAutoScan();
    void refresh().catch((err) => handlers.logLine(String(err), "SYS"));
    scanTimer = window.setInterval(() => {
      void refresh().catch((err) => handlers.logLine(String(err), "SYS"));
    }, 10000);
  }

  const handleListClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const item = target.closest(".device-item") as HTMLElement | null;
    if (!item) return;
    const address = item.dataset.address;
    if (!address) return;
    select(address);
  };

  pairList?.addEventListener("click", handleListClick);
  unpairedStoneList?.addEventListener("click", handleListClick);

  pairButton?.addEventListener("click", () => {
    if (!selected) {
      handlers.logLine("Select a device to pair", "SYS");
      return;
    }
    const isPaired = handlers.getDevices().some((d) => d.address === selected && d.paired);
    if (isPaired) {
      handlers.logLine(`Connecting to paired device: ${selected}`, "SYS");
    } else {
      handlers.logLine(`Initiating pairing for: ${selected}`, "SYS");
    }
    void handlers.onPair(selected);
  });

  return {
    render,
    refresh,
    startAutoScan,
    stopAutoScan,
  };
}
