import { renderHeader } from "./components/header";
import { renderRange } from "./components/range";
import { renderToggle } from "./components/toggle";
import { renderList, renderListItem } from "./components/list";
import { renderSection } from "./components/section";
import { renderSelect } from "./components/select";
import stoneImg from "./assets/stone.png";

export function renderHomePage() {
  return `
    <div class="page" id="page-home" data-page="home">
      ${renderHeader({
        title: "STONE 매니저",
        titleId: "appTitle",
        showBack: false,
        right: `
          <button class="nav-connect" id="navConnect" data-tauri-drag-region="false">
            <span class="material-symbols-rounded">bluetooth</span>
          </button>
          <button class="nav-info" id="navSettings" data-tauri-drag-region="false">
            <span class="material-symbols-rounded">settings</span>
          </button>
        `,
      })}
      <main class="layout">
        <section class="statusSection">
          <img src="${stoneImg}" class="device-image"/>
          <span class="status" id="status">STONE이 연결되지 않음</span>
          <div class="battery-container">
            <span class="material-symbols-rounded" id="batteryIcon">battery_android_question</span>
            <span class="battery" id="battery">--</span>
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
            ${renderList([
              renderListItem({
                label: "조명 밝기",
                col: true,
                body: renderRange({ id: "lampBrightness", min: 0, max: 100, step: 0.1, value: 0, className: "thumb-vertical" }),
              }),
              renderListItem({
                    label: "조명 색상",
                    right: renderSelect({
                      id: "lampType",
                      value: 1,
                      direction: "up",
                      options: [
                        { value: 1, label: "단일 색상" },
                        { value: 2, label: "촛불" },
                        { value: 3, label: "오로라" },
                        { value: 4, label: "파도" },
                        { value: 5, label: "반딧불" },
                      ],
                    }),
                    col: true,
                    body: renderRange({ id: "lampHue", min: 0, max: 360, step: 1, value: 0, className: "range-hue" }),
              }),
            ])}
          `,
        })}
      </main>
    </div>
  `;
}
