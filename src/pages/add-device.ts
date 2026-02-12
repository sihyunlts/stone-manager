import { renderHeader } from "../components/header";
import { renderSection } from "../components/section";
import { renderList, renderListItem } from "../components/list";
import type { DeviceInfo } from "../services/bluetooth";

export function renderAddDevicePage() {
  const addSection = renderSection({
    title: "기기 추가",
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

  return `
    <div class="page" id="page-pairing" data-page="pairing">
      ${renderHeader({ title: "기기 추가", showBack: true })}
      <main class="layout">
        ${addSection}
      </main>
    </div>
  `;
}

type AddDeviceHandlers = {
  getDevices: () => DeviceInfo[];
  refreshDevices: () => Promise<DeviceInfo[]>;
  onPair: (address: string) => void | Promise<void>;
  logLine: (line: string, tone?: "IN" | "OUT" | "SYS") => void;
};

export function initAddDevicePage(handlers: AddDeviceHandlers) {
  const pairList = document.querySelector<HTMLDivElement>("#pairList");
  const pairButton = document.querySelector<HTMLButtonElement>("#pairDevice");
  let selected = "";

  function select(address: string) {
    selected = address;
    pairList?.querySelectorAll(".device-item").forEach((item) => {
      item.classList.toggle("is-selected", item.getAttribute("data-address") === address);
    });
  }

  function render(devices: DeviceInfo[]) {
    if (!pairList) return;
    const connectedDevices = devices.filter((d) => d.connected && d.has_gaia);
    if (connectedDevices.length === 0) {
      selected = "";
      pairList.innerHTML = renderList([
        renderListItem({
          label: "연결된 기기가 없습니다.",
          value: "",
          className: "device-item-empty",
        }),
      ]);
      return;
    }
    pairList.innerHTML = renderList(
      connectedDevices.map((device) =>
        renderListItem({
          label: device.name ?? device.address,
          className: "device-item",
          data: { address: device.address },
        })
      )
    );
    if (selected && connectedDevices.some((d) => d.address === selected)) {
      select(selected);
      return;
    }
    const preferred = connectedDevices.find((d) => d.name?.toUpperCase().includes("STONE"));
    if (preferred) {
      select(preferred.address);
      return;
    }
    if (connectedDevices[0]) {
      select(connectedDevices[0].address);
    }
  }

  async function refresh() {
    const devices = await handlers.refreshDevices();
    render(devices);
  }

  pairList?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const item = target.closest(".device-item") as HTMLElement | null;
    if (!item) return;
    const address = item.dataset.address;
    if (!address) return;
    select(address);
  });

  pairButton?.addEventListener("click", () => {
    if (!selected) {
      handlers.logLine("Select a device to pair", "SYS");
      return;
    }
    void handlers.onPair(selected);
  });

  return {
    render,
    refresh,
  };
}
