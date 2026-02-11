import { renderHeader } from "../components/header";
import { renderSection } from "../components/section";
import { renderList, renderListItem } from "../components/list";

export function renderPairingPage() {
  const registerSection = renderSection({
    title: "기기 등록",
    body: `
      <div id="registerList">
        ${renderList([
          renderListItem({
            label: "연결된 기기가 없습니다.",
            value: "",
            className: "device-item-empty",
          }),
        ])}
      </div>
      <div class="row">
        <button id="registerDevice">등록</button>
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
