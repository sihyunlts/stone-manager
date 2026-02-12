import { animate } from "motion";
import { renderHeader } from "../components/header";
import { renderSection } from "../components/section";
import { renderList, renderListItem } from "../components/list";
import type { ConnectResultEvent, DeviceInfo } from "../services/bluetooth";

type PairFlowStage = "select" | "connecting" | "success" | "fail";

export function renderAddDevicePage() {
  const unpairedSection = renderSection({
    title: "검색된 기기",
    id: "pairingSelectSection",
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
      <div class="row">
        <button id="pairDevice">기기 추가</button>
      </div>
    `,
  });

  const flowSection = renderSection({
    title: "기기 연결",
    id: "pairFlowSection",
    className: "pair-flow-hidden",
    body: `
      <div class="card pair-flow">
        <div class="pair-flow-title" id="pairFlowTitle">연결 중</div>
        <div class="pair-flow-message" id="pairFlowMessage">잠시만 기다려 주세요.</div>
        <div class="pair-flow-actions" id="pairFlowActions">
          <button id="pairFlowPrimary">확인</button>
          <button id="pairFlowSecondary">취소</button>
        </div>
      </div>
    `,
  });

  return `
    <div class="page" id="page-pairing" data-page="pairing">
      ${renderHeader({ title: "기기 추가", showBack: true })}
      <main class="layout">
        ${unpairedSection}
        ${flowSection}
      </main>
    </div>
  `;
}

type AddDeviceHandlers = {
  getRegisteredAddresses: () => string[];
  refreshDevices: () => Promise<DeviceInfo[]>;
  scanUnpairedStoneDevices: () => Promise<DeviceInfo[]>;
  onPair: (address: string) => void | Promise<void>;
  onCancelPairing: (address: string) => void | Promise<void>;
  onConfirmSuccess: () => void;
  logLine: (line: string, tone?: "IN" | "OUT" | "SYS") => void;
};

function normalizeAddress(address: string) {
  return address.trim().toLowerCase();
}

function summarizeError(message: string | null | undefined) {
  if (!message) {
    return "연결에 실패했습니다.";
  }
  const compact = message.replace(/\s+/g, " ").trim();
  if (!compact) return "연결에 실패했습니다.";
  return compact.length > 90 ? `${compact.slice(0, 90)}...` : compact;
}

export function initAddDevicePage(handlers: AddDeviceHandlers) {
  const selectSection = document.querySelector<HTMLElement>("#pairingSelectSection");
  const flowSection = document.querySelector<HTMLElement>("#pairFlowSection");
  const flowTitle = document.querySelector<HTMLElement>("#pairFlowTitle");
  const flowMessage = document.querySelector<HTMLElement>("#pairFlowMessage");
  const flowPrimary = document.querySelector<HTMLButtonElement>("#pairFlowPrimary");
  const flowSecondary = document.querySelector<HTMLButtonElement>("#pairFlowSecondary");
  const unpairedStoneList = document.querySelector<HTMLDivElement>("#unpairedStoneList");
  const pairButton = document.querySelector<HTMLButtonElement>("#pairDevice");

  let selected = "";
  let cachedUnpairedStoneDevices: DeviceInfo[] = [];
  let scanTimer: number | null = null;
  let refreshInFlight = false;

  let flowStage: PairFlowStage = "select";
  let pendingAddress: string | null = null;
  let pendingName: string | null = null;
  let lastError: string | null = null;
  let cancelRequested = false;

  function animateStage(target: HTMLElement | null) {
    if (!target) return;
    animate(
      target,
      {
        opacity: [0, 1],
        y: [8, 0],
      } as any,
      {
        duration: 0.18,
      } as any
    );
  }

  function applyFlowView() {
    const inSelect = flowStage === "select";
    if (selectSection) {
      selectSection.classList.toggle("pair-flow-hidden", !inSelect);
    }
    if (flowSection) {
      flowSection.classList.toggle("pair-flow-hidden", inSelect);
    }

    if (inSelect) {
      animateStage(selectSection);
      return;
    }

    const deviceText = pendingName ?? pendingAddress ?? "STONE";
    if (flowStage === "connecting") {
      if (flowTitle) flowTitle.textContent = "연결 중";
      if (flowMessage) flowMessage.textContent = `${deviceText} 기기에 연결하고 있어요.`;
      if (flowPrimary) flowPrimary.style.display = "none";
      if (flowSecondary) flowSecondary.style.display = "none";
    } else if (flowStage === "success") {
      if (flowTitle) flowTitle.textContent = "연결 완료됨";
      if (flowMessage) flowMessage.textContent = `${deviceText} 연결이 완료되었습니다.`;
      if (flowPrimary) {
        flowPrimary.style.display = "";
        flowPrimary.textContent = "확인";
      }
      if (flowSecondary) flowSecondary.style.display = "none";
    } else {
      if (flowTitle) flowTitle.textContent = "연결 실패";
      if (flowMessage) flowMessage.textContent = summarizeError(lastError);
      if (flowPrimary) {
        flowPrimary.style.display = "";
        flowPrimary.textContent = "다시 선택";
      }
      if (flowSecondary) flowSecondary.style.display = "none";
    }

    animateStage(flowSection);
  }

  function setFlowStage(next: PairFlowStage) {
    flowStage = next;
    if (flowStage !== "select") {
      stopAutoScan();
    }
    applyFlowView();
  }

  function select(address: string) {
    selected = address;
    unpairedStoneList?.querySelectorAll(".device-item").forEach((item) => {
      item.classList.toggle("is-selected", item.getAttribute("data-address") === address);
    });
  }

  function render() {
    const registeredSet = new Set(
      handlers.getRegisteredAddresses().map((address) => address.toLowerCase())
    );
    const unpairedStoneDevices = cachedUnpairedStoneDevices.filter(
      (d) => !registeredSet.has(d.address.toLowerCase())
    );

    if (!selected || !unpairedStoneDevices.some((d) => d.address === selected)) {
      selected = "";
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
    } else if (unpairedStoneDevices[0]) {
      select(unpairedStoneDevices[0].address);
    }
  }

  async function refresh() {
    if (flowStage !== "select" || refreshInFlight) return;
    refreshInFlight = true;
    render();
    try {
      const devices = await handlers.refreshDevices();
      const unpairedStoneDevices = await handlers.scanUnpairedStoneDevices();
      cachedUnpairedStoneDevices = unpairedStoneDevices;
      void devices;
      render();
    } catch (err) {
      handlers.logLine(String(err), "SYS");
    } finally {
      refreshInFlight = false;
      render();
    }
  }

  function stopAutoScan() {
    if (scanTimer !== null) {
      window.clearInterval(scanTimer);
      scanTimer = null;
    }
  }

  function startAutoScan() {
    if (flowStage !== "select") {
      return;
    }
    stopAutoScan();
    void refresh().catch((err) => handlers.logLine(String(err), "SYS"));
    scanTimer = window.setInterval(() => {
      if (flowStage !== "select") return;
      void refresh().catch((err) => handlers.logLine(String(err), "SYS"));
    }, 10000);
  }

  function resetFlow(options?: { shouldRefresh?: boolean }) {
    pendingAddress = null;
    pendingName = null;
    lastError = null;
    cancelRequested = false;
    setFlowStage("select");
    if (options?.shouldRefresh !== false) {
      void refresh().catch((err) => handlers.logLine(String(err), "SYS"));
    }
  }

  function isConnecting() {
    return flowStage === "connecting";
  }

  function handleBackWhileConnecting() {
    if (flowStage !== "connecting" || !pendingAddress) {
      return;
    }
    cancelRequested = true;
    handlers.logLine(`Cancel pairing request: ${pendingAddress}`, "SYS");
    void handlers.onCancelPairing(pendingAddress);
    resetFlow({ shouldRefresh: false });
  }

  function handleConnectResult(result: ConnectResultEvent) {
    if (flowStage !== "connecting" || !pendingAddress) {
      return;
    }
    if (normalizeAddress(result.address) !== normalizeAddress(pendingAddress)) {
      return;
    }
    if (cancelRequested) {
      return;
    }

    if (result.ok) {
      setFlowStage("success");
    } else {
      lastError = result.error ?? "Connect failed";
      setFlowStage("fail");
    }
  }

  const handleListClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const item = target.closest(".device-item") as HTMLElement | null;
    if (!item) return;
    const address = item.dataset.address;
    if (!address) return;
    select(address);
  };

  unpairedStoneList?.addEventListener("click", handleListClick);

  pairButton?.addEventListener("click", () => {
    if (!selected) {
      handlers.logLine("Select a device to pair", "SYS");
      return;
    }
    const candidate = cachedUnpairedStoneDevices.find((device) => device.address === selected);
    pendingAddress = selected;
    pendingName = candidate?.name ?? selected;
    lastError = null;
    cancelRequested = false;
    handlers.logLine(`Initiating pairing for: ${selected}`, "SYS");
    setFlowStage("connecting");

    void Promise.resolve(handlers.onPair(selected)).catch((err) => {
      lastError = String(err);
      setFlowStage("fail");
    });
  });

  flowPrimary?.addEventListener("click", () => {
    if (flowStage === "success") {
      handlers.onConfirmSuccess();
      resetFlow({ shouldRefresh: false });
      return;
    }
    if (flowStage === "fail") {
      resetFlow();
    }
  });

  flowSecondary?.addEventListener("click", () => {
    if (flowStage === "connecting") {
      handleBackWhileConnecting();
    }
  });

  applyFlowView();

  return {
    render,
    refresh,
    startAutoScan,
    stopAutoScan,
    handleConnectResult,
    resetFlow,
    isConnecting,
    handleBackWhileConnecting,
  };
}
