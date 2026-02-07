export function renderSettingsPage() {
  return `
    <div class="page" id="page-settings" data-page="settings">
      <div class="app-header" data-tauri-drag-region>
        <button class="nav-back" data-tauri-drag-region="false">뒤로</button>
        <div class="app-title" data-tauri-drag-region="false">설정</div>
        <div class="header-spacer"></div>
      </div>
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
      </main>
    </div>
  `;
}
