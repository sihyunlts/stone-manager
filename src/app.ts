import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { animate } from "motion";
import { bindDevPage, renderDevPage } from "./pages/dev";
import { bindSettingsPage, renderSettingsPage } from "./pages/settings";
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
  getActiveDeviceAddress,
  getRegisteredDevices,
  removeRegisteredDevice,
  setActiveDeviceAddress,
  subscribeActiveDevice,
  subscribeRegisteredDevices,
} from "./state/registry";
import { renderHomePage } from "./pages/home";
import { initToast } from "./components/toast";
import { isActiveDeviceConnected, getActiveDeviceLabel } from "./state/active";
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
  updateLampUI,
} from "./services/lamp";
import {
  initDeviceInfo,
  requestStaticDeviceInfo,
  requestDynamicDeviceInfo,
  updateDeviceInfoUI,
} from "./services/device-info";

export function initApp() {
  const app = el<HTMLDivElement>("#app");
  app.innerHTML = `
    <div class="app-shell">
      <div id="pageHost">
        ${renderHomePage()}
        ${renderAddDevicePage()}
        ${renderSettingsPage()}
        ${renderDevPage()}
        ${renderLicensesPage()}
      </div>
    </div>
  `;
  const toast = initToast(app);

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
  const appTitle = el<HTMLDivElement>("#appTitle");
  const status = el<HTMLDivElement>("#status");
  const statusAction = el<HTMLButtonElement>("#statusAction");
  const statusUnpair = el<HTMLButtonElement>("#statusUnpair");
  const sectionSound = el<HTMLElement>("#sectionSound");
  const sectionLamp = el<HTMLElement>("#sectionLamp");
  const settingsStoneInfo = document.querySelector<HTMLElement>("#settingsStoneInfo");
  
  let connectController: ReturnType<typeof initConnectController> | null = null;
  let deviceSelectBinding: ReturnType<typeof bindSelect> | null = null;
  let addDevicePage: ReturnType<typeof initAddDevicePage> | null = null;
  let batteryPollingAddress: string | null = null;
  let primedAddress: string | null = null;

  // --- Navigation ---

  const { goTo, goBack, getCurrentPage } = initNavigation({
    pageHost,
    pages: {
      home: pageHome,
      dev: pageDev,
      settings: pageSettings,
      pairing: pagePairing,
      licenses: pageLicenses,
    },
    onPageChange: (to) => {
      if (to === "settings") {
        addDevicePage?.stopAutoScan();
        requestDynamicDeviceInfo();
      }
      if (to === "pairing") {
        addDevicePage?.resetFlow();
        addDevicePage?.startAutoScan();
      } else {
        addDevicePage?.stopAutoScan();
        addDevicePage?.resetFlow({ shouldRefresh: false });
      }
    }
  });

  // --- Device UI Helpers ---

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
    updateDeviceInfoUI();
    updateBatteryLabel();
    updateVolumeUI();
    updateLampUI();
    const connected = isActiveDeviceConnected();
    const active = getActiveDeviceAddress();
    if (connected && active) {
      if (batteryPollingAddress !== active) {
        startBatteryPolling();
        batteryPollingAddress = active;
      }
      if (primedAddress !== active) {
        requestBattery().catch((err) => logLine(String(err), "SYS"));
        requestVolume().catch((err) => logLine(String(err), "SYS"));
        requestLampState().catch((err) => logLine(String(err), "SYS"));
        requestStaticDeviceInfo();
        primedAddress = active;
      }
    } else {
      stopBatteryPolling();
      batteryPollingAddress = null;
      resetBatteryState();
      if (!active || active === primedAddress) {
        primedAddress = null;
      }
    }
    sectionSound.style.display = connected ? "" : "none";
    sectionLamp.style.display = connected ? "" : "none";
    if (settingsStoneInfo) {
      settingsStoneInfo.style.display = connected ? "" : "none";
    }
  }

  function updateConnectionStatus() {
    const active = getActiveDeviceAddress();
    const activeConnection = active ? getDeviceConnection(active) : null;
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
        const label = active
          ? connectController?.getDeviceLabel(active) ?? active
          : "Unknown";
        status.textContent = label;
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
      statusUnpair.style.display = "none";
      return;
    }
    statusAction.style.display = "";
    if (isActiveDeviceConnected()) {
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
      await connectController.addDevice(address);
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

  bindDevPage({
    onSend: async (vendorIdHex, commandIdHex, payloadHex) => {
      const vendorId = parseInt(vendorIdHex, 16);
      const commandId = parseInt(commandIdHex, 16);
      if (Number.isNaN(vendorId) || Number.isNaN(commandId)) {
        logLine("Invalid vendor or command id", "SYS");
        return;
      }
      const address = getActiveDeviceAddress();
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
  });

  bindSettingsPage(() => {
    logLine("Developer menu unlocked", "SYS");
    goTo("dev");
  });

  // --- UI Event Listeners ---

  statusAction.addEventListener("click", () => {
    const active = getActiveDeviceAddress();
    if (!active || !connectController) return;
    if (isActiveDeviceConnected()) {
      void connectController.disconnectAddress(active);
    } else {
      void connectController.connectAddress(active);
    }
  });

  statusUnpair.addEventListener("click", () => {
    const active = getActiveDeviceAddress();
    if (!active || isActiveDeviceConnected()) return;
    removeRegisteredDevice(active);
    removeDeviceConnection(active);
    updateConnectionStatus();
  });

  navSettings.addEventListener("click", () => goTo("settings"));
  navConnect.addEventListener("click", () => goTo("pairing"));
  
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
  navSidebarButtons.forEach((btn) => {
    btn.addEventListener("click", () => pageHome.classList.toggle("is-sidebar-collapsed"));
  });

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
  subscribeActiveDevice(() => { 
    const layout = pageHome?.querySelector<HTMLElement>(".layout");
    
    if (layout) {
      const exitSpring = {
        duration: 0.2,
        easing: [0.5, 0, 1, 0.5]
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
        syncActiveDeviceUI(); 

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
      syncActiveDeviceUI(); 
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
