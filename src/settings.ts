import { renderHeader } from "./components/header";
import { renderList, renderListItem } from "./components/list";
import { renderSection } from "./components/section";

export function renderSettingsPage() {
  const stoneInfo = renderSection({
    title: "STONE 정보",
    body: renderList([
      renderListItem({ label: "펌웨어 버전", valueId: "settingsFirmware" }),
      renderListItem({ label: "MAC 주소", valueId: "settingsMac" }),
      renderListItem({ label: "신호 강도 (RSSI)", valueId: "settingsRssi" }),
    ]),
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
        clickable: true,
        data: { url: "https://github.com/sihyunlts/stone-manager" },
      }),
      renderListItem({
        label: "오픈소스 라이선스",
        id: "navLicenses",
        clickable: true,
      }),
    ]),
  });

  return `
    <div class="page" id="page-settings" data-page="settings">
      ${renderHeader({ title: "설정", showBack: true })}
      <main class="layout">
        ${stoneInfo}
        ${appInfo}
      </main>
    </div>
  `;
}
