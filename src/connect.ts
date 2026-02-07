export function renderConnectPage() {
  return `
    <div class="page" id="page-connect" data-page="connect">
      <header class="app-header" data-tauri-drag-region>
        <button class="nav-back" data-tauri-drag-region="false">뒤로</button>
        <div class="app-title" data-tauri-drag-region="false">연결</div>
        <div class="header-spacer"></div>
      </header>
      <main class="layout">
        <section>
          <h2>기기 등록</h2>
          <div class="card">
            <div class="row">
              <select id="registerList"></select>
              <button id="registerDevice">등록</button>
            </div>
          </div>
        </section>

        <section>
          <h2>연결</h2>
          <div class="card">
            <div class="row">
              <button id="refreshDevices">새로고침</button>
              <select id="registeredList"></select>
              <button id="connect">연결</button>
              <button id="disconnect">연결 끊기</button>
              <button id="removeRegistered">삭제</button>
            </div>
          </div>
        </section>
      </main>
    </div>
  `;
}
