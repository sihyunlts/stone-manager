import { renderHeader } from "../components/header";
import { renderList, renderListItem } from "../components/list";
import { renderSection } from "../components/section";
import { renderSelect } from "../components/select";
import { renderToggle } from "../components/toggle";

export function renderSettingsPage() {
  const stoneSettings = renderSection({
    title: "앱 설정",
    body: renderList([
      renderListItem({
        label: "정밀 배터리 퍼센트 표시",
        value: "표시 값은 실제 잔량과 다를 수 있습니다.",
        right: renderToggle({ id: "settingsBatteryStepToggle" }),
        valueVisibleWhenChecked: true,
      }),
      renderListItem({
        label: "배터리 업데이트 주기",
        right: renderSelect({
          id: "settingsBatteryPollInterval",
          options: [
            { value: "10", label: "10초" },
            { value: "30", label: "30초" },
            { value: "60", label: "1분" },
            { value: "off", label: "수동" },
          ],
          value: "30",
        }),
      }),
    ]),
  });

  const stoneInfo = renderSection({
    title: "STONE 정보",
    id: "settingsStoneInfo",
    body: `
      ${renderList([
        renderListItem({ label: "펌웨어 버전", valueId: "settingsFirmware" }),
        renderListItem({ label: "MAC 주소", valueId: "settingsMac" }),
        renderListItem({ label: "신호 강도 (RSSI)", valueId: "settingsRssi" }),
      ])}
      ${renderList([
        renderListItem({
          label: "사용설명서",
          link: { url: "https://pfile.imholic.com:2822/Pantech/IM-100/IM-100S%20Manual%5B1%5D.pdf" },
        }),
      ])}
    `,
  });

  const appInfo = renderSection({
    title: "앱 정보",
    body: renderList([
      renderListItem({
        label: "버전",
        valueId: "settingsAppVersion",
        id: "settingsAppVersionRow",
      }),
      renderListItem({
        label: "GitHub 저장소",
        value: "sihyunlts/stone-manager",
        link: { url: "https://github.com/sihyunlts/stone-manager" },
      }),
      renderListItem({
        label: "오픈소스 라이선스",
        id: "navLicenses",
      }),
    ]),
  });

  return `
    <div class="page" id="page-settings" data-page="settings">
      ${renderHeader({ title: "설정", showBack: true })}
      <div class="layout-shell">
        <main class="layout">
          ${stoneSettings}
          ${stoneInfo}
          ${appInfo}
        </main>
      </div>
    </div>
  `;
}

export function bindSettingsPage(onUnlockDev: () => void) {
  const row = document.querySelector<HTMLDivElement>("#settingsAppVersionRow");
  if (!row) return;

  let clicks = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  row.addEventListener("click", () => {
    clicks++;
    if (timer) clearTimeout(timer);

    timer = setTimeout(() => {
      clicks = 0;
    }, 300);

    if (clicks >= 7) {
      clicks = 0;
      if (timer) clearTimeout(timer);
      onUnlockDev();
    }
  });
}
