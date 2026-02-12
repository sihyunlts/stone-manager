import { renderHeader } from "../components/header";
import { renderSection } from "../components/section";
import { renderList, renderListItem } from "../components/list";

type DevPageHandlers = {
  onSend: (vendorIdHex: string, commandIdHex: string, payloadHex: string) => void | Promise<void>;
  onPairingDebugMockSuccess: () => void;
  onPairingDebugMockFail: () => void;
  onOpenOnboarding: () => void;
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

  const pairingDebugSection = import.meta.env.DEV
    ? renderSection({
        title: "Pairing Flow Debug",
        body: `
          ${renderList([
            renderListItem({
              body: `
                <div class="row">
                  <button id="pairDebugMockSuccess">성공 플로우 진입</button>
                  <button id="pairDebugMockFail">실패 플로우 진입</button>
                </div>
              `,
            }),
          ])}
        `,
      })
    : "";

  const uiDebugSection = renderSection({
    title: "UI 디버그",
    body: renderList([
      renderListItem({
        body: `<button id="devOpenOnboarding">온보딩 진입</button>`,
      }),
    ]),
  });

  return `
    <div class="page" id="page-dev" data-page="dev">
      ${renderHeader({ title: "개발자 메뉴", showBack: true })}
      <main class="layout">
        ${gaiaSection}
        ${stoneInfoSection}
        ${pairingDebugSection}
        ${uiDebugSection}
      </main>
    </div>
  `;
}

export function bindDevPage(handlers: DevPageHandlers) {
  const sendButton = document.querySelector<HTMLButtonElement>("#sendGaia");
  if (sendButton) {
    sendButton.addEventListener("click", () => {
      handlers.onSend(
        getInputValue("#vendorId"),
        getInputValue("#commandId"),
        getInputValue("#payload")
      );
    });
  }

  const pairDebugMockSuccess = document.querySelector<HTMLButtonElement>("#pairDebugMockSuccess");
  if (pairDebugMockSuccess) {
    pairDebugMockSuccess.addEventListener("click", () => {
      handlers.onPairingDebugMockSuccess();
    });
  }

  const pairDebugMockFail = document.querySelector<HTMLButtonElement>("#pairDebugMockFail");
  if (pairDebugMockFail) {
    pairDebugMockFail.addEventListener("click", () => {
      handlers.onPairingDebugMockFail();
    });
  }

  const devOpenOnboarding = document.querySelector<HTMLButtonElement>("#devOpenOnboarding");
  if (devOpenOnboarding) {
    devOpenOnboarding.addEventListener("click", () => {
      handlers.onOpenOnboarding();
    });
  }
}
