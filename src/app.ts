import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { animate } from "motion";
import { bindDevPage, renderDevPage } from "./pages/dev";
import { bindSettingsPage, renderSettingsPage } from "./pages/settings";
import { initHeaderScrollTitle } from "./components/header";
import { syncHeaderInteractiveNoDrag } from "./components/header";
import { bindOnboardingPage, renderOnboardingPage } from "./pages/onboarding";
import {
  initConnectController,
  type DeviceInfo,
  type ConnectResultEvent,
  type DeviceStateEvent,
} from "./services/bluetooth";
import { initAddDevicePage, renderAddDevicePage } from "./pages/add-device";
import { renderLicensesPage } from "./pages/licenses";
import { renderSelect, bindSelect } from "./components/select";
import {
  getDeviceConnection,
  removeDeviceConnection,
  subscribeConnection,
} from "./state/connection";
import {
  getSelectedSingleDeviceAddress,
  getRegisteredDevices,
  removeRegisteredDevice,
  MULTI_CONTROL_SELECT_VALUE,
  setSelectedSingleDeviceAddress,
  setSelectedTargetMulti,
  subscribeRegisteredDevices,
  subscribeSelectedTarget,
  isSelectedTargetMulti,
} from "./state/registry";
import {
  isMultiControlMenuEnabled,
  setMultiControlMenuEnabled,
} from "./state/multi-control";
import { renderHomePage, initHomeConnectionUi } from "./pages/home";
import { initToast } from "./components/toast";
import {
  getSelectedDeviceLabel,
  isSelectedDeviceConnected,
} from "./state/active";
import { toHex, parseHexBytes, logLine } from "./utils/formatter";
import { el } from "./utils/dom";
import { initNavigation } from "./utils/navigation";
import { handleGaiaPacket, type GaiaPacketEvent } from "./services/gaia";
import {
  initBattery,
  requestBattery,
  updateBatteryLabel,
  resetBatteryState,
  stopBatteryPolling,
  startBatteryPolling,
} from "./services/battery";
import {
  initVolume,
  requestVolume,
  updateVolumeUI,
} from "./services/volume";
import {
  initLamp,
  requestLampState,
  resetLampState,
  updateLampUI,
} from "./services/lamp";
import {
  initDeviceInfo,
  requestStaticDeviceInfo,
  requestDynamicDeviceInfo,
  updateDeviceInfoUI,
} from "./services/device-info";

const ONBOARDING_SEEN_KEY = "stone.onboarding_seen_v1";

function shouldBootstrapBluetoothOnLaunch() {
  return !/Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent);
}

export function initApp() {
  const shouldShowOnboarding = window.localStorage.getItem(ONBOARDING_SEEN_KEY) !== "1";
  const app = el<HTMLDivElement>("#app");
  app.innerHTML = `
    <div class="app-shell">
      <div id="pageHost">
        ${renderHomePage()}
        ${renderOnboardingPage()}
        ${renderAddDevicePage()}
        ${renderSettingsPage()}
        ${renderDevPage()}
        ${renderLicensesPage()}
      </div>
    </div>
  `;
  syncHeaderInteractiveNoDrag();
  const toast = initToast(app);

  const navBackButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-back"));
  const navConnect = el<HTMLButtonElement>("#navConnect");
  const navSettings = el<HTMLButtonElement>("#navSettings");
  const pageHost = el<HTMLDivElement>("#pageHost");
  const pageHome = el<HTMLDivElement>("#page-home");
  const pageDev = el<HTMLDivElement>("#page-dev");
  const pageSettings = el<HTMLDivElement>("#page-settings");
  const pagePairing = el<HTMLDivElement>("#page-pairing");
  const pageLicenses = el<HTMLDivElement>("#page-licenses");
  const pageOnboarding = el<HTMLDivElement>("#page-onboarding");
  const appTitle = el<HTMLDivElement>("#appTitle");
  const statusSection = pageHome.querySelector<HTMLElement>(".statusSection");
  const status = el<HTMLDivElement>("#status");
  const batteryContainer = el<HTMLElement>("#batteryContainer");
  const statusAction = el<HTMLButtonElement>("#statusAction");
  const statusUnpair = el<HTMLButtonElement>("#statusUnpair");
  const sectionSound = el<HTMLElement>("#sectionSound");
  const sectionLamp = el<HTMLElement>("#sectionLamp");
  const settingsStoneInfo = document.querySelector<HTMLElement>("#settingsStoneInfo");
  
  let connectController: ReturnType<typeof initConnectController> | null = null;
  let addDevicePage: ReturnType<typeof initAddDevicePage> | null = null;
  let headerScrollTitle: ReturnType<typeof initHeaderScrollTitle> | null = null;
  let batteryPollingAddress: string | null = null;
  let primedAddress: string | null = null;
  let pendingPairingDebugAction: (() => void) | null = null;
  let didBootstrapBluetooth = false;
  const homeConnectionUi = initHomeConnectionUi({
    pageHome,
    statusSection,
    batteryContainer,
    sectionSound,
    sectionLamp,
  });

  // --- Navigation ---

  const { goTo, replaceTo, goBack, getCurrentPage } = initNavigation({
    pageHost,
    pages: {
      home: pageHome,
      dev: pageDev,
      settings: pageSettings,
      pairing: pagePairing,
      licenses: pageLicenses,
      onboarding: pageOnboarding,
    },
    initialPage: shouldShowOnboarding ? "onboarding" : "home",
    onPageChange: (to) => {
      if (to === "settings") {
        addDevicePage?.stopAutoScan();
        requestDynamicDeviceInfo();
      }
      if (to === "pairing") {
        addDevicePage?.resetFlow();
        addDevicePage?.startAutoScan();
        const action = pendingPairingDebugAction;
        pendingPairingDebugAction = null;
        if (action) {
          action();
        }
      } else {
        pendingPairingDebugAction = null;
        addDevicePage?.stopAutoScan();
        addDevicePage?.resetFlow({ shouldRefresh: false });
      }
      headerScrollTitle?.syncPage(to);
    }
  });

  headerScrollTitle = initHeaderScrollTitle({ collapseRangePx: 56 });
  headerScrollTitle.syncPage(getCurrentPage());

  // --- Device UI Helpers ---

  function renderDeviceTitle() {
    const devices = getRegisteredDevices();
    if (devices.length === 0) {
      appTitle.textContent = "STONE 매니저";
      syncHeaderInteractiveNoDrag();
      return;
    }
    const multiControlMenuEnabled = isMultiControlMenuEnabled();
    const options: Array<{ value: string; label: string; icon?: string }> = devices.map((device) => ({
      value: device.address,
      label: device.name ?? device.address,
    }));
    if (multiControlMenuEnabled) {
      options.push({
        value: MULTI_CONTROL_SELECT_VALUE,
        label: "동시 제어",
        icon: "select_all",
      });
    }
    const selectedValue = multiControlMenuEnabled && isSelectedTargetMulti()
      ? MULTI_CONTROL_SELECT_VALUE
      : getSelectedSingleDeviceAddress() ?? devices[0]?.address;
    appTitle.innerHTML = renderSelect({
      id: "deviceSelect",
      className: "select--title",
      options,
      value: selectedValue,
    });
    bindSelect("deviceSelect", (value) => {
      if (value === MULTI_CONTROL_SELECT_VALUE) {
        if (!isMultiControlMenuEnabled()) return;
        setSelectedTargetMulti();
        return;
      }
      setSelectedSingleDeviceAddress(value);
    });
    syncHeaderInteractiveNoDrag();
  }

  function syncActiveDeviceUI(options?: { animateHomeConnectionUi?: boolean }) {
    const animateHomeConnectionUi = options?.animateHomeConnectionUi ?? true;
    const multiSelected = isSelectedTargetMulti();
    const connected = isSelectedDeviceConnected();
    const selectedAddress = getSelectedSingleDeviceAddress();
    pageHome.classList.toggle("home--multi-control", multiSelected);
    updateConnectionStatus();
    updateStatusAction();
    updateDeviceInfoUI();
    updateBatteryLabel();
    updateVolumeUI();
    updateLampUI();
    if (!multiSelected && connected && selectedAddress) {
      if (batteryPollingAddress !== selectedAddress) {
        startBatteryPolling();
        batteryPollingAddress = selectedAddress;
      }
      if (primedAddress !== selectedAddress) {
        requestBattery().catch((err) => logLine(String(err), "SYS"));
        requestVolume().catch((err) => logLine(String(err), "SYS"));
        requestLampState().catch((err) => logLine(String(err), "SYS"));
        requestStaticDeviceInfo();
        primedAddress = selectedAddress;
      }
    } else {
      stopBatteryPolling();
      batteryPollingAddress = null;
      resetBatteryState();
      primedAddress = null;
      if (!multiSelected) {
        resetLampState();
      }
    }
    homeConnectionUi.sync(multiSelected || connected, { animate: animateHomeConnectionUi });
    if (settingsStoneInfo) {
      settingsStoneInfo.style.display = !multiSelected && connected ? "" : "none";
    }
  }

  function updateConnectionStatus() {
    if (isSelectedTargetMulti()) {
      status.textContent = "동시 제어";
      status.classList.add("connected");
      return;
    }
    const selectedAddress = getSelectedSingleDeviceAddress();
    const activeConnection = selectedAddress ? getDeviceConnection(selectedAddress) : null;
    const state = activeConnection?.state ?? "idle";
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
        const label = selectedAddress
          ? connectController?.getDeviceLabel(selectedAddress) ?? selectedAddress
          : "Unknown";
        status.textContent = label;
        status.classList.add("connected");
        break;
      }
      case "idle":
      default:
        status.textContent = `${getSelectedDeviceLabel() ?? "STONE"}이 연결되지 않음`;
        status.classList.remove("connected");
        break;
    }
  }

  function updateStatusAction() {
    if (isSelectedTargetMulti()) {
      statusAction.style.display = "none";
      statusUnpair.style.display = "none";
      return;
    }
    const selectedAddress = getSelectedSingleDeviceAddress();
    if (!selectedAddress) {
      statusAction.style.display = "none";
      statusUnpair.style.display = "none";
      return;
    }
    statusAction.style.display = "";
    if (isSelectedDeviceConnected()) {
      statusAction.textContent = "연결 끊기";
      statusAction.dataset.action = "disconnect";
      statusUnpair.style.display = "none";
    } else {
      statusAction.textContent = "연결";
      statusAction.dataset.action = "connect";
      statusUnpair.style.display = "";
    }
  }

  // --- Init Services ---

  initBattery();
  initVolume();
  initLamp();
  initDeviceInfo();

  connectController = initConnectController({
    logLine,
    onAutoPaired: (name) => toast.show(name),
  });
  addDevicePage = initAddDevicePage({
    getRegisteredAddresses: () => getRegisteredDevices().map((d) => d.address),
    refreshDevices: async () => {
      if (!connectController) return [];
      return await connectController.refreshDevices();
    },
    scanUnpairedStoneDevices: async () => {
      return (await invoke<DeviceInfo[]>("scan_unpaired_stone_devices")) ?? [];
    },
    onPair: async (address) => {
      if (!connectController) return;
      await connectController.addDevice(address, { suppressAutoPairedToast: true });
    },
    onCancelPairing: async (address) => {
      if (!connectController) return;
      void connectController.disconnectAddress(address);
    },
    onConfirmSuccess: () => {
      goBack();
      syncActiveDeviceUI();
    },
    logLine,
  });

  // --- Page Bindings ---

  function openPairingPage() {
    if (getCurrentPage() !== "pairing") {
      addDevicePage?.resetFlow({ shouldRefresh: false });
    }
    goTo("pairing");
  }

  function runPairingDebugAction(action: () => void) {
    if (getCurrentPage() === "pairing") {
      action();
      return;
    }
    pendingPairingDebugAction = action;
    openPairingPage();
  }

  function bootstrapBluetoothIfNeeded() {
    if (didBootstrapBluetooth) return;
    didBootstrapBluetooth = true;
    connectController?.refreshDevices()
      .then((devices) => {
        void devices;
        addDevicePage?.render();
        return connectController?.syncBackendConnections();
      })
      .then(() => {
        return connectController?.autoRegisterConnectedGaiaDevices();
      })
      .then(() => {
        return connectController?.autoConnectRegisteredDevices();
      })
      .catch((err) => logLine(String(err), "SYS"));
  }

  bindDevPage({
    onSend: async (vendorIdHex, commandIdHex, payloadHex) => {
      const vendorId = parseInt(vendorIdHex, 16);
      const commandId = parseInt(commandIdHex, 16);
      if (Number.isNaN(vendorId) || Number.isNaN(commandId)) {
        logLine("Invalid vendor or command id", "SYS");
        return;
      }
      const address = getSelectedSingleDeviceAddress();
      if (!address) {
        logLine("No active device selected", "SYS");
        return;
      }
      let payload = [];
      try { payload = parseHexBytes(payloadHex); } catch (err) { logLine(String(err), "SYS"); return; }
      try {
        await invoke("send_gaia_command", { address, vendorId, commandId, payload });
        logLine(`${toHex(vendorId, 4)} ${toHex(commandId, 4)} ${payload.length ? payload.map(b => toHex(b, 2)).join(" ") : "<empty>"}`, "OUT");
      } catch (err) { logLine(String(err), "SYS"); }
    },
    onPairingDebugMockSuccess: () => {
      runPairingDebugAction(() => {
        addDevicePage?.resetFlow({ shouldRefresh: false, keepDebugOutcome: true });
        addDevicePage?.debugPrepareSyntheticOutcome("success");
        addDevicePage?.render();
      });
    },
    onPairingDebugMockFail: () => {
      runPairingDebugAction(() => {
        addDevicePage?.resetFlow({ shouldRefresh: false, keepDebugOutcome: true });
        addDevicePage?.debugPrepareSyntheticOutcome("fail");
        addDevicePage?.render();
      });
    },
    onOpenOnboarding: () => {
      goTo("onboarding");
    },
    getMultiControlMenuEnabled: () => isMultiControlMenuEnabled(),
    onToggleMultiControlMenu: (enabled) => {
      const selectionWasMulti = isSelectedTargetMulti();
      setMultiControlMenuEnabled(enabled);
      renderDeviceTitle();
      if (!(selectionWasMulti && !enabled)) {
        syncActiveDeviceUI({ animateHomeConnectionUi: false });
      }
    },
  });

  bindOnboardingPage({
    onNext: () => {
      window.localStorage.setItem(ONBOARDING_SEEN_KEY, "1");
      if (shouldBootstrapBluetoothOnLaunch()) {
        bootstrapBluetoothIfNeeded();
      }
      replaceTo("pairing");
    },
  });

  bindSettingsPage(() => {
    logLine("Developer menu unlocked", "SYS");
    goTo("dev");
  });

  // --- UI Event Listeners ---

  statusAction.addEventListener("click", () => {
    if (isSelectedTargetMulti()) return;
    const selectedAddress = getSelectedSingleDeviceAddress();
    if (!selectedAddress || !connectController) return;
    if (isSelectedDeviceConnected()) {
      void connectController.disconnectAddress(selectedAddress);
    } else {
      void connectController.connectAddress(selectedAddress);
    }
  });

  statusUnpair.addEventListener("click", () => {
    if (isSelectedTargetMulti()) return;
    const selectedAddress = getSelectedSingleDeviceAddress();
    if (!selectedAddress || isSelectedDeviceConnected()) return;
    removeRegisteredDevice(selectedAddress);
    removeDeviceConnection(selectedAddress);
    updateConnectionStatus();
  });

  navSettings.addEventListener("click", () => goTo("settings"));
  navConnect.addEventListener("click", () => openPairingPage());
  
  const navLicenses = document.querySelector<HTMLDivElement>("#navLicenses");
  if (navLicenses) {
    navLicenses.addEventListener("click", () => goTo("licenses"));
  }

  navBackButtons.forEach((btn) =>
    btn.addEventListener("click", () => {
      if (getCurrentPage() === "pairing" && addDevicePage?.isConnecting()) {
        addDevicePage.handleBackWhileConnecting();
      }
      goBack();
    })
  );
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const item = target.closest("[data-url]") as HTMLElement;
    if (item && item.dataset.url) {
      invoke("open_url", { url: item.dataset.url }).catch((err) => logLine(String(err), "SYS"));
    }
  });

  // --- Subscriptions ---

  renderDeviceTitle();
  syncActiveDeviceUI();
  
  subscribeRegisteredDevices(() => {
    renderDeviceTitle();
    syncActiveDeviceUI();
    addDevicePage?.render();
  });
  subscribeSelectedTarget(() => {
    const layout = pageHome?.querySelector<HTMLElement>(".layout");

    if (layout) {
      const exitSpring = {
        duration: 0.2,
        ease: [0.5, 0, 1, 0.5]
      };

      const enterSpring = {
        type: "spring",
        stiffness: 600,
        damping: 60,
        mass: 0.8
      };

      animate(layout, 
        { 
          opacity: [1, 0], 
          y: [0, 0],
          scale: [1, 0.97],
        } as any, 
        exitSpring as any
      ).finished.then(() => {
        renderDeviceTitle();
        syncActiveDeviceUI({ animateHomeConnectionUi: false });

        animate(layout,
          {
            opacity: [0, 1],
            y: [15, 0],
            scale: [1, 1],
          } as any,
          enterSpring as any
        );
      });
    } else {
      renderDeviceTitle();
      syncActiveDeviceUI({ animateHomeConnectionUi: false });
    }
  });
  subscribeConnection(() => { syncActiveDeviceUI(); });

  // --- Tauri Listeners ---

  listen<ConnectResultEvent>("bt_connect_result", (event) => {
    connectController?.handleConnectResult(event.payload);
    addDevicePage?.handleConnectResult(event.payload);
    addDevicePage?.render();
  });
  listen<DeviceStateEvent>("bt_device_event", (event) => {
    connectController?.handleDeviceEvent(event.payload);
    addDevicePage?.render();
  });
  listen<GaiaPacketEvent>("gaia_packet", (event) => handleGaiaPacket(event.payload));

  if (!shouldShowOnboarding && shouldBootstrapBluetoothOnLaunch()) {
    bootstrapBluetoothIfNeeded();
  }
}
