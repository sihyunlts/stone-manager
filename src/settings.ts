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
          <div class="card">
            <div class="grid dev-info-grid">
              <div>펌웨어 버전</div><div id="settingsFirmware">--</div>
              <div>MAC</div><div id="settingsMac">--</div>
              <div>RSSI</div><div id="settingsRssi">--</div>
            </div>
          </div>
        </section>
      </main>
    </div>
  `;
}
