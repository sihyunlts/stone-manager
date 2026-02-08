type HeaderOptions = {
  title: string;
  titleId?: string;
  right?: string;
  showBack?: boolean;
};

export function renderHeader(options: HeaderOptions) {
  const { title, titleId, right, showBack } = options;
  const titleAttrs = titleId ? ` id="${titleId}"` : "";
  const leftSlot = showBack ? `<div class="header-left"><button class="nav-back" data-tauri-drag-region="false">뒤로</button></div>` : "";
  const rightSlot = right ? `<div class="header-right">${right}</div>` : `<div class="header-spacer"></div>`;
  
  return `
    <header class="app-header" data-tauri-drag-region>
      ${leftSlot}
      <div class="app-title"${titleAttrs} data-tauri-drag-region>${title}</div>
      ${rightSlot}
    </header>
  `;
}
