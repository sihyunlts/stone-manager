import { renderHeader } from "./components/header";
import { renderSection } from "./components/section";
import { renderSelect } from "./components/select";

export function renderConnectPage() {
  const registerSection = renderSection({
    title: "기기 등록",
    body: `
      <div class="card">
        <div class="row">
          ${renderSelect({ id: "registerList", options: [] })}
          <button id="registerDevice">등록</button>
        </div>
      </div>
    `,
  });

  const connectSection = renderSection({
    title: "연결",
    body: `
      <div class="card">
        <div class="row">
          <button id="refreshDevices">새로고침</button>
          ${renderSelect({ id: "registeredList", options: [] })}
          <button id="connect">연결</button>
          <button id="disconnect">연결 끊기</button>
          <button id="removeRegistered">삭제</button>
        </div>
      </div>
    `,
  });

  return `
    <div class="page" id="page-connect" data-page="connect">
      ${renderHeader({ title: "연결", showBack: true })}
      <main class="layout">
        ${registerSection}
        ${connectSection}
      </main>
    </div>
  `;
}
