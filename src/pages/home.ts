import { animate, stagger } from "motion";
import { renderHeader } from "../components/header";
import { renderRange } from "../components/range";
import { renderToggle } from "../components/toggle";
import { renderList, renderListItem } from "../components/list";
import { renderSection } from "../components/section";
import { renderSelect } from "../components/select";
import { renderButton } from "../components/button";
import stoneImg from "../assets/stone.png";

export function renderHomePage() {
  return `
    <div class="page" id="page-home" data-page="home">
      ${renderHeader({
        title: "STONE 매니저",
        titleId: "appTitle",
        showBack: false,
        right: `
          ${renderButton({
            id: "navConnect",
            className: "nav-connect",
            html: `<span class="material-symbols-rounded">add_2</span>`,
            kind: "icon",
            tone: "secondary",
            attrs: {
              "data-tauri-drag-region": "false",
              "aria-label": "기기 추가",
            },
          })}
          ${renderButton({
            id: "navSettings",
            className: "nav-info",
            html: `<span class="material-symbols-rounded">settings</span>`,
            kind: "icon",
            tone: "secondary",
            attrs: {
              "data-tauri-drag-region": "false",
              "aria-label": "설정",
            },
          })}
        `,
      })}
      <main class="layout">
        <section class="statusSection">
          <img src="${stoneImg}" class="device-image"/>
          <span class="status" id="status">STONE이 연결되지 않음</span>
          <div class="battery-container" id="batteryContainer">
            <span class="material-symbols-rounded" id="batteryIcon">battery_android_question</span>
            <span class="battery" id="battery">--</span>
          </div>
          <div class="status-actions">
            ${renderButton({
              id: "statusUnpair",
              text: "등록 해제",
              tone: "danger",
            })}
            ${renderButton({
              id: "statusAction",
              text: "연결",
              tone: "secondary",
            })}
          </div>
        </section>

        ${renderSection({
          title: "소리",
          id: "sectionSound",
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
          id: "sectionLamp",
          body: `
            ${renderList([
              renderListItem({
                label: "램프 사용",
                right: renderToggle({ id: "lampToggle" }),
              }),
            ])}
            <div id="lampSettings" class="collapsible-group">
              ${renderList([
                renderListItem({
                  label: "조명 밝기",
                  col: true,
                  body: renderRange({ id: "lampBrightness", min: 0, max: 100, step: 0.1, value: 0, className: "thumb-vertical" }),
                }),
                renderListItem({
                      label: "조명 종류",
                      right: renderSelect({
                        id: "lampType",
                        value: 1,
                        direction: "up",
                        options: [
                          { value: 1, label: "단일 색상", icon: "palette" },
                          { value: 2, label: "촛불", icon: "candle" },
                          { value: 3, label: "오로라", icon: "heat" },
                          { value: 4, label: "파도", icon: "waves" },
                          { value: 5, label: "반딧불", icon: "flare" },
                        ],
                      }),
                      col: true,
                      body: `
                      <div id="lampHueContainer">
                        ${renderRange({ id: "lampHue", min: 0, max: 360, step: 1, value: 0, className: "range-hue" })}
                      </div>
                    `,
                }),
              ])}
            </div>
          `,
        })}
      </main>
    </div>
  `;
}

type HomeConnectionUiOptions = {
  pageHome: HTMLElement;
  statusSection: HTMLElement | null;
  batteryContainer: HTMLElement;
  sectionSound: HTMLElement;
  sectionLamp: HTMLElement;
};

type HomeConnectionUiController = {
  sync: (connected: boolean, options?: { animate?: boolean }) => void;
};

export function initHomeConnectionUi(
  options: HomeConnectionUiOptions
): HomeConnectionUiController {
  const { pageHome, statusSection, batteryContainer, sectionSound, sectionLamp } = options;
  const statusLayoutDuration = 0.75;
  const statusLayoutEase = [0.5, 0, 0, 1] as const;
  const panelEnterDuration = 0.6;
  const panelEnterEase = [0.22, 1, 0.36, 1] as const;
  const panelEnterStaggerStep = 0.05;
  const panelEnterStartRatio = 0.72;

  let connectedState: boolean | null = null;
  let transitionToken = 0;
  let animations: Array<{ cancel: () => void }> = [];

  function trackAnimation<T extends { cancel: () => void }>(animation: T) {
    animations.push(animation);
    return animation;
  }

  function cancelAnimations() {
    animations.forEach((animation) => animation.cancel());
    animations = [];
  }

  function getPanels() {
    return [batteryContainer, sectionSound, sectionLamp];
  }

  function setLayoutMode(connected: boolean) {
    pageHome.classList.toggle("home--connected", connected);
    pageHome.classList.toggle("home--disconnected", !connected);
  }

  // Smoothly interpolate status card position using a flip-style layout transition.
  function animateStatusSectionLayout(
    token: number,
    connected: boolean,
    beforeTopOverride?: number
  ) {
    if (!statusSection) {
      setLayoutMode(connected);
      return;
    }

    const beforeTop = beforeTopOverride ?? statusSection.getBoundingClientRect().top;
    setLayoutMode(connected);
    const afterTop = statusSection.getBoundingClientRect().top;
    const deltaY = beforeTop - afterTop;

    if (Math.abs(deltaY) < 0.5) {
      statusSection.style.transform = "";
      return;
    }

    statusSection.style.transform = `translateY(${deltaY}px)`;
    trackAnimation(
      animate(
        statusSection,
        { transform: [`translateY(${deltaY}px)`, "translateY(0px)"] } as any,
        { duration: statusLayoutDuration, ease: statusLayoutEase } as any
      )
    ).finished.then(() => {
      if (token !== transitionToken) return;
      statusSection.style.transform = "";
    });
  }

  // Apply the initial connected/disconnected UI state immediately, without animation.
  function applyState(connected: boolean) {
    setLayoutMode(connected);
    const panels = getPanels();
    for (const panel of panels) {
      panel.style.display = connected ? "" : "none";
      panel.style.opacity = connected ? "1" : "0";
      panel.style.transform = "";
    }
    if (statusSection) {
      statusSection.style.transform = "";
    }
  }

  // Run top-of-home UI transition animations when connection state changes.
  function transition(connected: boolean) {
    const token = ++transitionToken;
    cancelAnimations();
    if (statusSection) {
      statusSection.style.transform = "";
    }
    const panels = getPanels();

    if (connected) {
      // Connected: move the status card with layout transition, then reveal panels with staggered enter.
      const enterBaseDelay = statusLayoutDuration * panelEnterStartRatio;
      const showDelay = stagger(panelEnterStaggerStep);
      const beforeTop = statusSection?.getBoundingClientRect().top;
      panels.forEach((panel) => {
        panel.style.display = "";
        panel.style.opacity = "0";
        panel.style.transform = "translateY(12px)";
      });
      animateStatusSectionLayout(token, true, beforeTop);

      panels.forEach((panel, index) => {
        trackAnimation(
          animate(
            panel,
            { opacity: [0, 1], y: [12, 0] } as any,
            {
              duration: panelEnterDuration,
              ease: panelEnterEase,
              delay: enterBaseDelay + showDelay(index, panels.length),
            } as any
          )
        );
      });
      return;
    }

    // Disconnected: stagger-hide panels first, then move the status card back to center.
    const hideDelay = stagger(0.05, { from: "last" });
    const hidePromises = panels.map((panel, index) => {
      const animation = trackAnimation(
        animate(
          panel,
          { opacity: [1, 0], y: [0, 12] } as any,
          {
            duration: 0.2,
            ease: [0.4, 0, 1, 1],
            delay: hideDelay(index, panels.length),
          } as any
        )
      );
      return animation.finished
        .then(() => {
          if (token !== transitionToken || connectedState !== false) return;
          panel.style.display = "none";
          panel.style.opacity = "0";
          panel.style.transform = "";
        })
        .catch(() => undefined);
    });

    void Promise.all(hidePromises).then(() => {
      if (token !== transitionToken || connectedState !== false) return;
      animateStatusSectionLayout(token, false);
    });
  }

  // Sync from app.ts and transition only when the connected state actually changes.
  function sync(connected: boolean, options?: { animate?: boolean }) {
    const shouldAnimate = options?.animate ?? true;
    const prev = connectedState;
    connectedState = connected;
    if (prev === null) {
      applyState(connected);
      return;
    }
    if (prev === connected) {
      if (!shouldAnimate) {
        cancelAnimations();
        applyState(connected);
      }
      return;
    }
    if (!shouldAnimate) {
      cancelAnimations();
      applyState(connected);
      return;
    }
    transition(connected);
  }

  return {
    sync,
  };
}
