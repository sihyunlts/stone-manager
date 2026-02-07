import { renderHeader } from "./components/header";

export function renderSettingsPage() {
  return `
    <div class="page" id="page-settings" data-page="settings">
      ${renderHeader({ title: "설정", showBack: true })}
      <main class="layout">
        <section>
          <h2>STONE 정보</h2>
          <div class="card list-group">
            <div class="list-item">
              <div class="list-label">펌웨어 버전</div>
              <div class="list-value" id="settingsFirmware">--</div>
            </div>
            <div class="list-item">
              <div class="list-label">MAC 주소</div>
              <div class="list-value" id="settingsMac">--</div>
            </div>
            <div class="list-item">
              <div class="list-label">신호 강도 (RSSI)</div>
              <div class="list-value" id="settingsRssi">--</div>
            </div>
          </div>
        </section>
        <section>
          <h2>앱 정보</h2>
          <div class="card list-group">
            <div class="list-item" id="settingsAppVersionRow">
              <div class="list-label">버전</div>
              <div class="list-value" id="settingsAppVersion">--</div>
            </div>
          </div>
        </section>
      </main>
    </div>
  `;
}
