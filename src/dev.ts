type DevPageHandlers = {
  onSend: (vendorIdHex: string, commandIdHex: string, payloadHex: string) => void | Promise<void>;
};

function getInputValue(selector: string) {
  const input = document.querySelector<HTMLInputElement>(selector);
  return input?.value.trim() ?? "";
}

export function renderDevPage() {
  return `
    <main class="layout" id="devPage">
      <section>
        <h2>GAIA 커맨드 전송</h2>
        <div class="card">
          <div class="grid">
            <label>
              벤더 ID (hex)
              <input id="vendorId" value="5054" />
            </label>
            <label>
              커맨드 ID (hex)
              <input id="commandId" value="0201" />
            </label>
            <label class="wide">
              페이로드 (hex)
              <input id="payload" placeholder="e.g. 1E or 0A0B0C" />
            </label>
          </div>
          <div class="row">
            <button id="send">전송</button>
          </div>
        </div>
      </section>
    </main>
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
