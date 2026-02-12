import { animate } from "motion";
import stoneImg from "../assets/stone.png";
import { renderHeader } from "../components/header";
import type { ConnectResultEvent, DeviceInfo } from "../services/bluetooth";

type PairFlowStage = "select" | "connecting" | "success" | "fail";
type DebugSyntheticOutcome = "success" | "fail";

type PairCandidate = {
  address: string;
  name: string;
  synthetic: boolean;
};

const DEBUG_VIRTUAL_DEVICES: PairCandidate[] = [
  {
    address: "debug-stone-virtual-a",
    name: "STONE DEBUG A",
    synthetic: true,
  },
  {
    address: "debug-stone-virtual-b",
    name: "STONE DEBUG B",
    synthetic: true,
  },
];

const STAGE_CLASS_MAP: Record<PairFlowStage, string> = {
  select: "pair-stage--select",
  connecting: "pair-stage--connecting",
  success: "pair-stage--success",
  fail: "pair-stage--fail",
};

export function renderAddDevicePage() {
  return `
    <div class="page" id="page-pairing" data-page="pairing">
      ${renderHeader({ title: "기기 추가", showBack: true })}
      <main class="layout pairing-layout pair-stage pair-stage--select" id="pairingStage">
        <div class="pair-carousel-wrap" id="pairCarouselWrap">
          <div class="pair-select-scroll" id="pairSelectScroll"></div>
          <div class="pair-select-dots" id="pairSelectDots"></div>
          <button id="pairSelectConnect" class="pair-select-connect">연결</button>
        </div>

        <div class="pair-card-status pair-flow-hidden" id="pairCardStatus">
          <div class="pair-flow-title" id="pairFlowTitle">연결 중</div>
          <div class="pair-flow-message" id="pairFlowMessage">잠시만 기다려 주세요.</div>
          <div class="pair-flow-actions" id="pairFlowActions">
            <button id="pairFlowPrimary">확인</button>
            <button id="pairFlowSecondary">취소</button>
          </div>
        </div>
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
  const pairingStage = document.querySelector<HTMLElement>("#pairingStage");
  const pairSelectScroll = document.querySelector<HTMLDivElement>("#pairSelectScroll");
  const pairSelectDots = document.querySelector<HTMLDivElement>("#pairSelectDots");
  const pairSelectConnect = document.querySelector<HTMLButtonElement>("#pairSelectConnect");

  const pairCardStatus = document.querySelector<HTMLElement>("#pairCardStatus");

  const flowTitle = document.querySelector<HTMLElement>("#pairFlowTitle");
  const flowMessage = document.querySelector<HTMLElement>("#pairFlowMessage");
  const flowPrimary = document.querySelector<HTMLButtonElement>("#pairFlowPrimary");
  const flowSecondary = document.querySelector<HTMLButtonElement>("#pairFlowSecondary");

  let selected = "";
  let cachedUnpairedStoneDevices: DeviceInfo[] = [];
  let scanTimer: number | null = null;
  let refreshInFlight = false;
  let refreshToken = 0;
  let scrollSyncRaf: number | null = null;
  let stageTransitionToken = 0;
  let stageAnimations: Array<{ cancel: () => void }> = [];

  let lastRenderMode: "empty" | "list" | null = null;
  let lastRenderSignature = "";
  let lastRenderedSelected = "";
  let lastEmptyMessage = "";

  let flowStage: PairFlowStage = "select";
  let pendingAddress: string | null = null;
  let pendingName: string | null = null;
  let lastError: string | null = null;
  let cancelRequested = false;
  let pendingSynthetic = false;
  let debugSyntheticOutcome: DebugSyntheticOutcome | null = null;
  let debugVirtualDevicesEnabled = false;

  function trackStageAnimation(animation: { cancel: () => void }) {
    stageAnimations.push(animation);
    return animation;
  }

  function cancelStageAnimations() {
    stageAnimations.forEach((animation) => animation.cancel());
    stageAnimations = [];
  }

  function setStageClass() {
    if (!pairingStage) return;
    pairingStage.classList.remove(
      "pair-stage--select",
      "pair-stage--connecting",
      "pair-stage--success",
      "pair-stage--fail"
    );
    pairingStage.classList.add(STAGE_CLASS_MAP[flowStage]);
  }

  function resetRenderedListCache() {
    selected = "";
    cachedUnpairedStoneDevices = [];
    lastRenderMode = null;
    lastRenderSignature = "";
    lastRenderedSelected = "";
    lastEmptyMessage = "";
  }

  function invalidateRefresh() {
    refreshToken += 1;
    refreshInFlight = false;
  }

  function buildDeviceSignature(devices: PairCandidate[]) {
    return devices
      .map((device) => `${device.address}|${device.name}|${device.synthetic ? "1" : "0"}`)
      .join("||");
  }

  function getUnpairedStoneDevices(): PairCandidate[] {
    const registeredSet = new Set(
      handlers.getRegisteredAddresses().map((address) => address.toLowerCase())
    );

    const virtualDevices = import.meta.env.DEV && debugVirtualDevicesEnabled
      ? DEBUG_VIRTUAL_DEVICES.filter((device) => !registeredSet.has(device.address.toLowerCase()))
      : [];

    const realDevices = cachedUnpairedStoneDevices
      .filter((d) => !registeredSet.has(d.address.toLowerCase()))
      .map((d) => ({
        address: d.address,
        name: d.name ?? d.address,
        synthetic: false,
      }));

    return [...virtualDevices, ...realDevices];
  }

  function findCandidate(address: string) {
    return getUnpairedStoneDevices().find((candidate) => candidate.address === address) ?? null;
  }

  function select(address: string) {
    selected = address;
  }

  function scrollToAddress(address: string, behavior: ScrollBehavior = "smooth") {
    if (!pairSelectScroll) return;

    const cards = Array.from(
      pairSelectScroll.querySelectorAll<HTMLElement>(".pair-select-card-item")
    );
    const selectedCard = cards.find((card) => card.dataset.address === address);
    if (!selectedCard) return;

    const targetLeft =
      selectedCard.offsetLeft - (pairSelectScroll.clientWidth - selectedCard.offsetWidth) / 2;
    pairSelectScroll.scrollTo({ left: Math.max(0, targetLeft), behavior });
  }

  function syncSelectionFromScroll(scrollEl: HTMLElement) {
    const cards = Array.from(
      scrollEl.querySelectorAll<HTMLElement>(".pair-select-card-item")
    );
    if (cards.length === 0) return;

    const center = scrollEl.scrollLeft + scrollEl.clientWidth / 2;
    let nearestIndex = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    cards.forEach((card, index) => {
      const cardCenter = card.offsetLeft + card.offsetWidth / 2;
      const distance = Math.abs(cardCenter - center);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    });

    const nearestCard = cards[nearestIndex];
    const nearestAddress = nearestCard.dataset.address;
    if (nearestAddress) {
      selected = nearestAddress;
      lastRenderedSelected = nearestAddress;
    }

    cards.forEach((card, index) => {
      card.classList.toggle("is-selected", index === nearestIndex);
    });

    const dots = Array.from(pairSelectDots?.querySelectorAll<HTMLElement>(".pair-select-dot") ?? []);
    dots.forEach((dot, index) => {
      dot.classList.toggle("is-active", index === nearestIndex);
    });
  }

  function getSelectedCardElement() {
    if (!pairSelectScroll) return null;
    const targetAddress = pendingAddress ?? selected;
    if (!targetAddress) return null;
    const cards = Array.from(
      pairSelectScroll.querySelectorAll<HTMLElement>(".pair-select-card-item")
    );
    return cards.find((card) => card.dataset.address === targetAddress) ?? null;
  }

  function renderFlowText() {
    const deviceText = pendingName ?? pendingAddress ?? "STONE";

    if (flowStage === "connecting") {
      if (flowTitle) flowTitle.textContent = "연결 중";
      if (flowMessage) flowMessage.textContent = `${deviceText} 기기에 연결하고 있어요.`;
      if (flowPrimary) flowPrimary.style.display = "none";
      if (flowSecondary) flowSecondary.style.display = "none";
      return;
    }

    if (flowStage === "success") {
      if (flowTitle) flowTitle.textContent = "연결 완료됨";
      if (flowMessage) flowMessage.textContent = `${deviceText} 연결이 완료되었습니다.`;
      if (flowPrimary) {
        flowPrimary.style.display = "";
        flowPrimary.textContent = "확인";
      }
      if (flowSecondary) flowSecondary.style.display = "none";
      return;
    }

    if (flowTitle) flowTitle.textContent = "연결 실패";
    if (flowMessage) flowMessage.textContent = summarizeError(lastError);
    if (flowPrimary) {
      flowPrimary.style.display = "";
      flowPrimary.textContent = "다시 선택";
    }
    if (flowSecondary) flowSecondary.style.display = "none";
  }

  function transitionToFlow() {
    const token = ++stageTransitionToken;
    if (!pairCardStatus) return;
    cancelStageAnimations();

    if (pendingAddress) {
      scrollToAddress(pendingAddress, "auto");
    }
    pairSelectScroll?.classList.add("is-locked");
    pairCardStatus.classList.remove("pair-flow-hidden");
    pairSelectDots?.classList.remove("pair-flow-hidden");
    pairSelectConnect?.classList.remove("pair-flow-hidden");

    const selectedCard = getSelectedCardElement();
    if (selectedCard) {
      trackStageAnimation(
        animate(
          selectedCard,
          { scale: [1, 0.985], y: [0, -2] },
          { duration: 0.2, ease: "easeOut" }
        )
      );
    }

    trackStageAnimation(
      animate(
        pairCardStatus,
        { opacity: [0, 1], y: [8, 0] },
        { duration: 0.2, ease: "easeOut" }
      )
    );
    if (pairSelectDots) {
      trackStageAnimation(
        animate(
          pairSelectDots,
          { opacity: [1, 0], y: [0, -4] },
          { duration: 0.16, ease: "easeIn" }
        )
      ).finished.then(() => {
        if (token !== stageTransitionToken || flowStage === "select") return;
        pairSelectDots.classList.add("pair-flow-hidden");
      });
    }
    if (pairSelectConnect) {
      trackStageAnimation(
        animate(
          pairSelectConnect,
          { opacity: [1, 0], y: [0, 6] },
          { duration: 0.16, ease: "easeIn" }
        )
      ).finished.then(() => {
        if (token !== stageTransitionToken || flowStage === "select") return;
        pairSelectConnect.classList.add("pair-flow-hidden");
      });
    }
  }

  function transitionToSelect() {
    const token = ++stageTransitionToken;
    if (!pairCardStatus) return;
    cancelStageAnimations();

    pairSelectScroll?.classList.remove("is-locked");
    pairSelectDots?.classList.remove("pair-flow-hidden");
    pairSelectConnect?.classList.remove("pair-flow-hidden");

    const selectedCard = getSelectedCardElement();
    if (selectedCard) {
      trackStageAnimation(
        animate(
          selectedCard,
          { scale: [0.985, 1], y: [-2, 0] },
          { duration: 0.18, ease: "easeOut" }
        )
      );
    }

    if (pairSelectDots) {
      trackStageAnimation(
        animate(
          pairSelectDots,
          { opacity: [0, 1], y: [-4, 0] },
          { duration: 0.18, ease: "easeOut" }
        )
      );
    }
    if (pairSelectConnect) {
      trackStageAnimation(
        animate(
          pairSelectConnect,
          { opacity: [0, 1], y: [6, 0] },
          { duration: 0.18, ease: "easeOut" }
        )
      );
    }

    trackStageAnimation(
      animate(
        pairCardStatus,
        { opacity: [1, 0], y: [0, 6] },
        { duration: 0.16, ease: "easeIn" }
      )
    ).finished.then(() => {
      if (token !== stageTransitionToken) return;
      pairCardStatus.classList.add("pair-flow-hidden");
    });
  }

  function pulseFlowStatus() {
    if (!pairCardStatus) return;
    cancelStageAnimations();
    pairSelectScroll?.classList.add("is-locked");
    pairSelectDots?.classList.add("pair-flow-hidden");
    pairSelectConnect?.classList.add("pair-flow-hidden");
    pairCardStatus.classList.remove("pair-flow-hidden");
    trackStageAnimation(
      animate(
        pairCardStatus,
        { opacity: [0.9, 1], y: [4, 0] },
        { duration: 0.18, ease: "easeOut" }
      )
    );
  }

  function setFlowStage(next: PairFlowStage) {
    const prev = flowStage;
    if (prev === next) {
      if (next !== "select") {
        renderFlowText();
        pulseFlowStatus();
      }
      return;
    }

    flowStage = next;
    setStageClass();

    if (flowStage !== "select") {
      stopAutoScan();
      renderFlowText();
      if (prev === "select") {
        transitionToFlow();
      } else {
        pulseFlowStatus();
      }
      return;
    }

    transitionToSelect();
  }

  function renderSelectDevices(devices: PairCandidate[]) {
    if (!pairSelectScroll || !pairSelectDots || !pairSelectConnect) return;

    if (devices.length === 0) {
      const emptyMessage = refreshInFlight ? "STONE 기기 검색 중..." : "표시할 기기가 없습니다.";
      if (lastRenderMode === "empty" && lastEmptyMessage === emptyMessage) {
        return;
      }

      pairSelectScroll.innerHTML = `
        <div class="pair-select-empty">
          <div class="pair-select-empty-title">${emptyMessage}</div>
          <div class="pair-select-empty-message">기기 전원을 켠 뒤 잠시 기다려 주세요.</div>
        </div>
      `;
      pairSelectDots.innerHTML = "";
      pairSelectDots.style.display = "none";
      pairSelectConnect.style.display = "none";

      lastRenderMode = "empty";
      lastRenderSignature = "";
      lastRenderedSelected = "";
      lastEmptyMessage = emptyMessage;
      return;
    }

    if (!selected || !devices.some((device) => device.address === selected)) {
      selected = devices[0].address;
    }

    const signature = buildDeviceSignature(devices);
    if (lastRenderMode === "list" && lastRenderSignature === signature) {
      if (lastRenderedSelected !== selected) {
        scrollToAddress(selected, "auto");
        syncSelectionFromScroll(pairSelectScroll);
      }
      return;
    }

    const selectedIndex = Math.max(
      0,
      devices.findIndex((device) => device.address === selected)
    );

    const cardsMarkup = devices
      .map((device, index) => {
        const isSelected = index === selectedIndex;
        return `
          <article
            class="pair-select-card-item${isSelected ? " is-selected" : ""}"
            data-address="${device.address}"
            role="button"
            tabindex="0"
          >
            <img src="${stoneImg}" class="pair-select-image" alt="STONE" />
            <div class="pair-select-name">${device.name}</div>
            <div class="pair-select-address">${device.address}</div>
          </article>
        `;
      })
      .join("");

    const dotsMarkup = devices
      .map(
        (device, index) => `
          <button
            class="pair-select-dot${index === selectedIndex ? " is-active" : ""}"
            data-address="${device.address}"
            aria-label="${index + 1}번째 기기"
          ></button>
        `
      )
      .join("");

    pairSelectScroll.innerHTML = cardsMarkup;
    pairSelectDots.innerHTML = dotsMarkup;
    pairSelectDots.style.display = "";
    pairSelectConnect.style.display = "";

    scrollToAddress(selected, "auto");
    syncSelectionFromScroll(pairSelectScroll);

    lastRenderMode = "list";
    lastRenderSignature = signature;
    lastRenderedSelected = selected;
    lastEmptyMessage = "";
  }

  function beginPair(address: string) {
    const candidate = findCandidate(address);
    if (!candidate) {
      handlers.logLine("Select a device to pair", "SYS");
      return;
    }

    pendingAddress = candidate.address;
    pendingName = candidate.name;
    lastError = null;
    cancelRequested = false;
    pendingSynthetic = candidate.synthetic;

    handlers.logLine(`Initiating pairing for: ${candidate.address}`, "SYS");
    setFlowStage("connecting");

    if (candidate.synthetic) {
      if (debugSyntheticOutcome) {
        const outcome = debugSyntheticOutcome;
        const expectedAddress = candidate.address;
        debugSyntheticOutcome = null;

        window.setTimeout(() => {
          if (flowStage !== "connecting" || cancelRequested) return;
          if (!pendingAddress || normalizeAddress(pendingAddress) !== normalizeAddress(expectedAddress)) {
            return;
          }

          if (outcome === "success") {
            setFlowStage("success");
          } else {
            lastError = "Debug simulated failure";
            setFlowStage("fail");
          }
        }, 380);
      }
      return;
    }

    void Promise.resolve(handlers.onPair(candidate.address)).catch((err) => {
      lastError = String(err);
      setFlowStage("fail");
    });
  }

  function render() {
    const devices = getUnpairedStoneDevices();
    if (flowStage !== "select") return;
    renderSelectDevices(devices);
  }

  async function refresh() {
    if (flowStage !== "select" || refreshInFlight) return;
    const token = ++refreshToken;
    refreshInFlight = true;
    render();
    try {
      const devices = await handlers.refreshDevices();
      const unpairedStoneDevices = await handlers.scanUnpairedStoneDevices();
      if (token !== refreshToken || flowStage !== "select") return;
      cachedUnpairedStoneDevices = unpairedStoneDevices;
      void devices;
      render();
    } catch (err) {
      if (token !== refreshToken || flowStage !== "select") return;
      handlers.logLine(String(err), "SYS");
    } finally {
      if (token !== refreshToken) return;
      refreshInFlight = false;
      if (flowStage !== "select") return;
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

  function resetFlow(options?: { shouldRefresh?: boolean; keepDebugOutcome?: boolean }) {
    invalidateRefresh();
    resetRenderedListCache();
    pendingAddress = null;
    pendingName = null;
    lastError = null;
    cancelRequested = false;
    pendingSynthetic = false;

    if (!options?.keepDebugOutcome) {
      debugSyntheticOutcome = null;
      debugVirtualDevicesEnabled = false;
    }

    setFlowStage("select");
    if (options?.shouldRefresh !== false) {
      void refresh().catch((err) => handlers.logLine(String(err), "SYS"));
    } else {
      render();
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
    if (!pendingSynthetic) {
      void handlers.onCancelPairing(pendingAddress);
    }
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

  function debugPrepareSyntheticOutcome(outcome: DebugSyntheticOutcome) {
    if (!import.meta.env.DEV) return;
    debugSyntheticOutcome = outcome;
    debugVirtualDevicesEnabled = true;
  }

  const handleSelectClick = (event: MouseEvent) => {
    if (flowStage !== "select") return;
    const target = event.target as HTMLElement;

    const dot = target.closest(".pair-select-dot") as HTMLButtonElement | null;
    if (dot?.dataset.address) {
      select(dot.dataset.address);
      scrollToAddress(dot.dataset.address, "smooth");
      return;
    }

    const connectButton = target.closest("#pairSelectConnect");
    if (connectButton) {
      if (!selected) {
        handlers.logLine("Select a device to pair", "SYS");
        return;
      }
      beginPair(selected);
      return;
    }

    const card = target.closest(".pair-select-card-item") as HTMLElement | null;
    if (!card) return;
    const address = card.dataset.address;
    if (!address) return;
    select(address);
    scrollToAddress(address, "smooth");
  };

  const handleSelectScroll = (event: Event) => {
    if (flowStage !== "select") return;
    const target = event.target as HTMLElement;
    if (!target || target.id !== "pairSelectScroll") return;

    if (scrollSyncRaf !== null) {
      window.cancelAnimationFrame(scrollSyncRaf);
    }
    scrollSyncRaf = window.requestAnimationFrame(() => {
      scrollSyncRaf = null;
      syncSelectionFromScroll(target);
    });
  };

  pairSelectScroll?.addEventListener("scroll", handleSelectScroll, { passive: true });
  pairSelectScroll?.addEventListener("click", handleSelectClick);
  pairSelectDots?.addEventListener("click", handleSelectClick);
  pairSelectConnect?.addEventListener("click", handleSelectClick);

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

  setStageClass();
  render();

  return {
    render,
    refresh,
    startAutoScan,
    stopAutoScan,
    handleConnectResult,
    resetFlow,
    isConnecting,
    handleBackWhileConnecting,
    debugPrepareSyntheticOutcome,
  };
}
