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

type BoundHeader = {
  pageId: string;
  headerEl: HTMLElement;
  scrollEl: HTMLElement;
  dynamicTitle?: {
    collapsedTitleEl: HTMLElement;
    largeTitleEl: HTMLElement;
  };
  rafId: number | null;
  onScroll: () => void;
  syncNow: () => void;
};

type HeaderScrollTitleController = {
  syncPage: (pageId: string) => void;
};

const HEADER_INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "[role=\"button\"]",
  ".select",
].join(", ");

export function syncHeaderInteractiveNoDrag(root: ParentNode = document) {
  const headers = Array.from(root.querySelectorAll<HTMLElement>(".app-header"));
  headers.forEach((header) => {
    const interactiveNodes = Array.from(
      header.querySelectorAll<HTMLElement>(HEADER_INTERACTIVE_SELECTOR)
    );
    interactiveNodes.forEach((node) => {
      node.setAttribute("data-tauri-drag-region", "false");
    });
  });
}

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

function applyProgress(binding: BoundHeader, collapseRangePx: number) {
  const isScrolled = binding.scrollEl.scrollTop > 0;
  binding.headerEl.classList.toggle("is-scrolled", isScrolled);

  const dynamicTitle = binding.dynamicTitle;
  if (!dynamicTitle) {
    binding.headerEl.classList.remove("is-title-collapsed");
    return;
  }

  const progress = clamp(binding.scrollEl.scrollTop / collapseRangePx, 0, 1);
  const largeOpacity = 1 - progress;

  const isCollapsed = progress >= 1;
  binding.headerEl.classList.toggle("is-title-collapsed", isCollapsed);
  dynamicTitle.collapsedTitleEl.style.opacity = "";
  dynamicTitle.collapsedTitleEl.style.transform = "";
  dynamicTitle.largeTitleEl.style.opacity = `${largeOpacity}`;
  dynamicTitle.largeTitleEl.style.transform = "";
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

function bindHeader(
  pageEl: HTMLElement,
  collapseRangePx: number
): BoundHeader | null {
  const headerEl = pageEl.querySelector<HTMLElement>(".app-header");
  if (!headerEl) return null;

  const pageId = pageEl.dataset.page ?? "";
  if (!pageId) return null;

  const layoutEl = pageEl.querySelector<HTMLElement>("main.layout");
  const scrollEl = pageEl.querySelector<HTMLElement>(".layout-shell") ?? layoutEl;
  if (!scrollEl) return null;

  let dynamicTitle: BoundHeader["dynamicTitle"];
  const isDynamicScrollTitle = headerEl.dataset.scrollTitle === "dynamic";
  if (isDynamicScrollTitle && layoutEl) {
    const collapsedTitleEl = headerEl.querySelector<HTMLElement>(".app-title--collapsed");
    const title = headerEl.dataset.headerTitle ?? collapsedTitleEl?.textContent?.trim() ?? "";
    if (collapsedTitleEl && title) {
      const largeTitleEl = ensureLargeTitle(layoutEl, title);
      layoutEl.classList.add("has-dynamic-header-title");
      dynamicTitle = {
        collapsedTitleEl,
        largeTitleEl,
      };
    }
  }

  const binding: BoundHeader = {
    pageId,
    headerEl,
    scrollEl,
    dynamicTitle,
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

  scrollEl.addEventListener("scroll", binding.onScroll, { passive: true });
  binding.syncNow();

  return binding;
}

export function initHeaderScrollTitle(
  options: HeaderScrollTitleOptions = {}
): HeaderScrollTitleController {
  const collapseRangePx = Math.max(1, options.collapseRangePx ?? 56);
  const pageNodes = Array.from(document.querySelectorAll<HTMLElement>(".page"));
  const bindingsByPageId = new Map<string, BoundHeader>();

  pageNodes.forEach((pageEl) => {
    const binding = bindHeader(pageEl, collapseRangePx);
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
