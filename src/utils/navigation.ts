import { animate } from "motion";

export type PageId = "home" | "dev" | "settings" | "pairing" | "licenses" | "onboarding";

export interface NavigationOptions {
  pageHost: HTMLElement;
  pages: Record<PageId, HTMLElement>;
  initialPage?: PageId;
  onPageChange?: (to: PageId) => void;
}

export function initNavigation(options: NavigationOptions) {
  const { pageHost, pages, initialPage = "home", onPageChange } = options;
  let currentPage: PageId = initialPage;
  let isTransitioning = false;
  const pageHistory: PageId[] = [];

  // Initial state
  Object.values(pages).forEach(page => {
    page.style.zIndex = "0";
    animate(page, { x: "100%" }, { duration: 0 });
  });
  
  pages[currentPage].style.zIndex = "1";
  animate(pages[currentPage], { x: "0%" }, { duration: 0 });

  function resetPageStack() {
    Object.values(pages).forEach(page => {
      page.style.zIndex = "0";
    });
  }

  async function navigate(to: PageId, direction: "forward" | "back") {
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

    currentPage = to;
    if (onPageChange) onPageChange(to);
    pageHost.style.pointerEvents = "";
    isTransitioning = false;
  }

  function goTo(to: PageId) {
    if (isTransitioning || to === currentPage) return;
    pageHistory.push(currentPage);
    void navigate(to, "forward");
  }

  function replaceTo(to: PageId) {
    if (isTransitioning || to === currentPage) return;
    void navigate(to, "forward");
  }

  function goBack() {
    if (isTransitioning) return;
    const target = pageHistory.pop();
    void navigate(target ?? "home", "back");
  }

  return { goTo, replaceTo, goBack, getCurrentPage: () => currentPage };
}
