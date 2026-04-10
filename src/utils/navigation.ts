import { animate } from "motion";

export type PageId = "home" | "dev" | "settings" | "pairing" | "licenses" | "onboarding";
type NavigationDirection = "forward" | "back";

type NavigationState = {
  page: PageId;
  navIndex: number;
};

export interface NavigationOptions {
  pageHost: HTMLElement;
  pages: Record<PageId, HTMLElement>;
  initialPage?: PageId;
  onBeforePageChange?: (from: PageId, to: PageId, direction: NavigationDirection) => void;
  onPageChange?: (to: PageId) => void;
}

export function initNavigation(options: NavigationOptions) {
  const { pageHost, pages, initialPage = "home", onBeforePageChange, onPageChange } = options;
  let currentPage: PageId = initialPage;
  let currentNavIndex = 0;
  let isTransitioning = false;
  let hasPendingHistorySync = false;

  // Initial state
  Object.values(pages).forEach(page => {
    page.style.zIndex = "0";
    animate(page, { x: "100%" }, { duration: 0 });
  });

  pages[currentPage].style.zIndex = "1";
  animate(pages[currentPage], { x: "0%" }, { duration: 0 });
  window.history.replaceState({ page: currentPage, navIndex: currentNavIndex }, "");

  function resetPageStack() {
    Object.values(pages).forEach(page => {
      page.style.zIndex = "0";
    });
  }

  function isPageId(value: unknown): value is PageId {
    return value === "home"
      || value === "dev"
      || value === "settings"
      || value === "pairing"
      || value === "licenses"
      || value === "onboarding";
  }

  function normalizeHistoryState(value: unknown): NavigationState {
    if (
      typeof value === "object"
      && value !== null
      && "page" in value
      && "navIndex" in value
      && isPageId(value.page)
      && typeof value.navIndex === "number"
      && Number.isInteger(value.navIndex)
      && value.navIndex >= 0
    ) {
      return {
        page: value.page,
        navIndex: value.navIndex,
      };
    }

    const fallbackState = {
      page: currentPage,
      navIndex: currentNavIndex,
    };
    window.history.replaceState(fallbackState, "");
    return fallbackState;
  }

  function getHistoryState() {
    return normalizeHistoryState(window.history.state);
  }

  async function navigate(to: PageId, direction: NavigationDirection) {
    if (isTransitioning || to === currentPage) return;
    isTransitioning = true;
    pageHost.style.pointerEvents = "none";

    const bring = pages[to];
    const leave = pages[currentPage];

    resetPageStack();

    if (direction === "forward") {
      bring.style.zIndex = "2";
      leave.style.zIndex = "1";
      const springConfig = {
        type: "spring" as const,
        stiffness: 450,
        damping: 40
      };
      await Promise.all([
        animate(bring, { x: ["100%", "0%"] }, springConfig).finished,
        animate(leave, { x: ["0%", "-20%"] }, springConfig).finished,
      ]);
    } else {
      bring.style.zIndex = "1";
      leave.style.zIndex = "2";
      const springConfig = {
        type: "spring" as const,
        stiffness: 600,
        damping: 60,
      };
      await Promise.all([
        animate(leave, { x: ["0%", "100%"] }, springConfig).finished,
        animate(bring, { x: ["-20%", "0%"] }, springConfig).finished,
      ]);
      leave.style.zIndex = "0";
    }

    pageHost.style.pointerEvents = "";
    isTransitioning = false;
  }

  async function syncWithHistory() {
    const nextState = getHistoryState();
    if (nextState.page === currentPage && nextState.navIndex === currentNavIndex) {
      return;
    }

    if (isTransitioning) {
      hasPendingHistorySync = true;
      return;
    }

    const direction: NavigationDirection = nextState.navIndex < currentNavIndex ? "back" : "forward";
    onBeforePageChange?.(currentPage, nextState.page, direction);
    await navigate(nextState.page, direction);
    currentPage = nextState.page;
    currentNavIndex = nextState.navIndex;
    onPageChange?.(nextState.page);

    if (hasPendingHistorySync) {
      hasPendingHistorySync = false;
      void syncWithHistory();
    }
  }

  function goTo(to: PageId) {
    if (isTransitioning || to === currentPage) return;
    window.history.pushState({ page: to, navIndex: currentNavIndex + 1 }, "");
    void syncWithHistory();
  }

  function goToWithBackTarget(to: PageId, backTarget: PageId) {
    if (isTransitioning || to === currentPage) return;
    window.history.replaceState({ page: backTarget, navIndex: currentNavIndex }, "");
    window.history.pushState({ page: to, navIndex: currentNavIndex + 1 }, "");
    void syncWithHistory();
  }

  function goBack() {
    if (isTransitioning) return;
    if (currentNavIndex <= 0) return;
    window.history.back();
  }

  window.addEventListener("popstate", () => {
    void syncWithHistory();
  });

  return {
    goTo,
    goToWithBackTarget,
    goBack,
    getCurrentPage: () => currentPage,
  };
}
