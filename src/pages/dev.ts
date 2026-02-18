import { renderHeader } from "../components/header";
import { renderSection } from "../components/section";
import { renderList, renderListItem } from "../components/list";
import { renderButton } from "../components/button";

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
          body: renderButton({ id: "sendGaia", text: "전송", tone: "primary" }),
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

  const uiDebugSection = renderSection({
    title: "UI 디버그",
    body: renderList([
      renderListItem({
        label: "온보딩 진입",
        id: "devOpenOnboarding",
      }),
      renderListItem({
        label: "페어링 성공 플로우 진입",
        id: "pairDebugMockSuccess",
      }),
      renderListItem({
        label: "페어링 실패 플로우 진입",
        id: "pairDebugMockFail",
      }),
    ]),
  });

  return `
    <div class="page" id="page-dev" data-page="dev">
      ${renderHeader({ title: "개발자 메뉴", showBack: true })}
      <div class="layout-shell">
        <main class="layout">
          ${gaiaSection}
          ${stoneInfoSection}
          ${uiDebugSection}
        </main>
      </div>
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

  const pairDebugMockSuccess = document.querySelector<HTMLElement>("#pairDebugMockSuccess");
  if (pairDebugMockSuccess) {
    pairDebugMockSuccess.addEventListener("click", () => {
      handlers.onPairingDebugMockSuccess();
    });
  }

  const pairDebugMockFail = document.querySelector<HTMLElement>("#pairDebugMockFail");
  if (pairDebugMockFail) {
    pairDebugMockFail.addEventListener("click", () => {
      handlers.onPairingDebugMockFail();
    });
  }

  const devOpenOnboarding = document.querySelector<HTMLElement>("#devOpenOnboarding");
  if (devOpenOnboarding) {
    devOpenOnboarding.addEventListener("click", () => {
      handlers.onOpenOnboarding();
    });
  }
}
