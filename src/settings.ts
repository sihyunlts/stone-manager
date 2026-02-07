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
