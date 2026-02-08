import { renderHeader } from "./components/header";
import { renderSection } from "./components/section";
import { renderList, renderListItem } from "./components/list";

type DevPageHandlers = {
  onSend: (vendorIdHex: string, commandIdHex: string, payloadHex: string) => void | Promise<void>;
};

function getInputValue(selector: string) {
  const input = document.querySelector<HTMLInputElement>(selector);
  return input?.value.trim() ?? "";
}

export function renderDevPage() {
  const gaiaSection = renderSection({
    title: "GAIA 커맨드 전송",
    body: `
      ${renderList([
        renderListItem({
          label: "벤더 ID (hex)",
          col: true,
          body: `<input id="vendorId" value="5054"/>`,
        }),
        renderListItem({
          label: "커맨드 ID (hex)",
          col: true,
          body: `<input id="commandId" value="0201"/>`,
        }),
        renderListItem({
          label: "페이로드 (hex)",
          col: true,
          body: `<input id="payload" placeholder="e.g. 1E or 0A0B0C"/>`,
        }),
        renderListItem({
          label: "전송",
          col: true,
          body: `<button id="sendGaia">전송</button>`,
        }),
      ])}
    `,
  });

  const stoneInfoSection = renderSection({
    title: "STONE 정보",
    body: renderList([
      renderListItem({ label: "이름", valueId: "devInfoName" }),
      renderListItem({ label: "휠 카운트", valueId: "devInfoWheel" }),
    ]),
  });

  return `
    <div class="page" id="page-dev" data-page="dev">
      ${renderHeader({ title: "개발자 메뉴", showBack: true })}
      <main class="layout">
        ${gaiaSection}
        ${stoneInfoSection}
      </main>
    </div>
  `;
}

export function bindDevPage(handlers: DevPageHandlers) {
  const sendButton = document.querySelector<HTMLButtonElement>("#send");
  if (!sendButton) return;
  sendButton.addEventListener("click", () => {
    handlers.onSend(
      getInputValue("#vendorId"),
      getInputValue("#commandId"),
      getInputValue("#payload")
    );
  });
}
