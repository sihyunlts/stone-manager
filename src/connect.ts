import { renderHeader } from "./components/header";

export function renderConnectPage() {
  return `
    <div class="page" id="page-connect" data-page="connect">
      ${renderHeader({ title: "연결", showBack: true })}
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
