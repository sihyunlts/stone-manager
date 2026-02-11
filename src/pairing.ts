import { renderHeader } from "./components/header";
import { renderSection } from "./components/section";
import { renderSelect } from "./components/select";

export function renderPairingPage() {
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

  return `
    <div class="page" id="page-pairing" data-page="pairing">
      ${renderHeader({ title: "기기 등록", showBack: true })}
      <main class="layout">
        ${registerSection}
      </main>
    </div>
  `;
}
