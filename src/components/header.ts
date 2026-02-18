import { renderButton } from "./button";

type HeaderOptions = {
  title: string;
  titleId?: string;
  right?: string;
  showBack?: boolean;
  scrollTitle?: "dynamic" | "static";
};

type HeaderScrollTitleOptions = {
  collapseRangePx?: number;
};

type BoundDynamicHeader = {
  pageId: string;
  headerEl: HTMLElement;
  layoutEl: HTMLElement;
  collapsedTitleEl: HTMLElement;
  largeTitleEl: HTMLElement;
  rafId: number | null;
  onScroll: () => void;
  syncNow: () => void;
};

type HeaderScrollTitleController = {
  syncPage: (pageId: string) => void;
};

export function renderHeader(options: HeaderOptions) {
  const { title, titleId, right, showBack, scrollTitle } = options;
  const resolvedScrollTitle = scrollTitle ?? (showBack ? "dynamic" : "static");
  const isDynamicScrollTitle = resolvedScrollTitle === "dynamic";

  const leftSlot = showBack
    ? `
      <div class="header-left">
        ${renderButton({
          className: "nav-back",
          html: `<span class="material-symbols-rounded">arrow_back</span>`,
          kind: "icon",
          tone: "secondary",
          attrs: {
            "data-tauri-drag-region": "false",
            "aria-label": "뒤로",
          },
        })}
      </div>
    `
    : "";

  const rightSlot = right
    ? `<div class="header-right">${right}</div>`
    : `<div class="header-spacer"></div>`;

  const titleAttrs = titleId ? ` id="${titleId}"` : "";
  const headerAttrs = isDynamicScrollTitle
    ? ` data-scroll-title="dynamic" data-header-title="${title.replace(/"/g, "&quot;")}"`
    : "";
  const titleClass = `app-title${isDynamicScrollTitle ? " app-title--collapsed" : ""}`;

  return `
    <header class="app-header" data-tauri-drag-region${headerAttrs}>
      <div class="header-content">
        ${leftSlot}
        <div class="${titleClass}"${titleAttrs} data-tauri-drag-region>${title}</div>
        ${rightSlot}
      </div>
    </header>
  `;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function applyProgress(binding: BoundDynamicHeader, collapseRangePx: number) {
  const progress = clamp(binding.layoutEl.scrollTop / collapseRangePx, 0, 1);
  const largeOpacity = 1 - progress;

  const isCollapsed = progress >= 1;
  binding.headerEl.classList.toggle("is-title-collapsed", isCollapsed);
  binding.collapsedTitleEl.style.opacity = "";
  binding.collapsedTitleEl.style.transform = "";
  binding.largeTitleEl.style.opacity = `${largeOpacity}`;
  binding.largeTitleEl.style.transform = "";
}

function ensureLargeTitle(layoutEl: HTMLElement, title: string) {
  const existing = layoutEl.querySelector<HTMLElement>(".app-title--large");
  if (existing) {
    existing.textContent = title;
    return existing;
  }

  const largeTitle = document.createElement("h1");
  largeTitle.className = "app-title--large";
  largeTitle.textContent = title;
  largeTitle.setAttribute("aria-hidden", "true");
  layoutEl.prepend(largeTitle);
  return largeTitle;
}

function bindDynamicHeader(
  pageEl: HTMLElement,
  collapseRangePx: number
): BoundDynamicHeader | null {
  const headerEl = pageEl.querySelector<HTMLElement>(".app-header[data-scroll-title=\"dynamic\"]");
  if (!headerEl) return null;

  const layoutEl = pageEl.querySelector<HTMLElement>("main.layout");
  if (!layoutEl) return null;

  const collapsedTitleEl = headerEl.querySelector<HTMLElement>(".app-title--collapsed");
  if (!collapsedTitleEl) return null;

  const pageId = pageEl.dataset.page ?? "";
  if (!pageId) return null;

  const title = headerEl.dataset.headerTitle ?? collapsedTitleEl.textContent?.trim() ?? "";
  if (!title) return null;

  const largeTitleEl = ensureLargeTitle(layoutEl, title);
  layoutEl.classList.add("has-dynamic-header-title");

  const binding: BoundDynamicHeader = {
    pageId,
    headerEl,
    layoutEl,
    collapsedTitleEl,
    largeTitleEl,
    rafId: null,
    onScroll: () => {
      if (binding.rafId !== null) return;
      binding.rafId = window.requestAnimationFrame(() => {
        binding.rafId = null;
        applyProgress(binding, collapseRangePx);
      });
    },
    syncNow: () => {
      if (binding.rafId !== null) {
        window.cancelAnimationFrame(binding.rafId);
        binding.rafId = null;
      }
      applyProgress(binding, collapseRangePx);
    },
  };

  layoutEl.addEventListener("scroll", binding.onScroll, { passive: true });
  binding.syncNow();

  return binding;
}

export function initHeaderScrollTitle(
  options: HeaderScrollTitleOptions = {}
): HeaderScrollTitleController {
  const collapseRangePx = Math.max(1, options.collapseRangePx ?? 56);
  const pageNodes = Array.from(document.querySelectorAll<HTMLElement>(".page"));
  const bindingsByPageId = new Map<string, BoundDynamicHeader>();

  pageNodes.forEach((pageEl) => {
    const binding = bindDynamicHeader(pageEl, collapseRangePx);
    if (!binding) return;
    bindingsByPageId.set(binding.pageId, binding);
  });

  function syncPage(pageId: string) {
    bindingsByPageId.get(pageId)?.syncNow();
  }

  return {
    syncPage,
  };
}
