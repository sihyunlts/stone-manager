type HeaderOptions = {
  title: string;
  titleId?: string;
  right?: string;
  showBack?: boolean;
};

export function renderHeader(options: HeaderOptions) {
  const { title, titleId, right, showBack } = options;

  const leftSlot = showBack
    ? `
      <div class="header-left">
        <button class="nav-back" data-tauri-drag-region="false">
          <span class="material-symbols-rounded">arrow_back</span>
        </button>
      </div>
    `
    : "";

  const rightSlot = right
    ? `<div class="header-right">${right}</div>`
    : `<div class="header-spacer"></div>`;

  const titleAttrs = titleId ? ` id="${titleId}"` : "";

  return `
    <header class="app-header" data-tauri-drag-region>
      <div class="header-content">
        ${leftSlot}
        <div class="app-title"${titleAttrs} data-tauri-drag-region>${title}</div>
        ${rightSlot}
      </div>
    </header>
  `;
}
