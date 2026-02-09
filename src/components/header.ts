type HeaderOptions = {
  title: string;
  titleId?: string;
  right?: string;
  showBack?: boolean;
  showSidebarToggle?: boolean;
};

export function renderHeader(options: HeaderOptions) {
  const { title, titleId, right, showBack, showSidebarToggle = false } = options;

  const leftButtons = [
    showSidebarToggle
      ? `
        <button class="nav-sidebar" data-tauri-drag-region="false">
          <span class="material-symbols-rounded">menu</span>
        </button>
      `
      : "",
    showBack
      ? `
        <button class="nav-back" data-tauri-drag-region="false">
          <span class="material-symbols-rounded">arrow_back</span>
        </button>
      `
      : "",
  ]
    .filter(Boolean)
    .join("");

  const rightSlot = right
    ? `<div class="header-right">${right}</div>`
    : `<div class="header-spacer"></div>`;

  const titleAttrs = titleId ? ` id="${titleId}"` : "";
  const leftSlot = `
    <div class="header-left">
      ${leftButtons ? `<div class="header-actions">${leftButtons}</div>` : ""}
      <div class="app-title"${titleAttrs} data-tauri-drag-region>${title}</div>
    </div>
  `;

  return `
    <header class="app-header" data-tauri-drag-region>
      <div class="header-content">
        ${leftSlot}
        ${rightSlot}
      </div>
    </header>
  `;
}
