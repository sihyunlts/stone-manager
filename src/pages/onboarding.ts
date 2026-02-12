type OnboardingHandlers = {
  onNext: () => void;
};

export function renderOnboardingPage() {
  return `
    <div class="page" id="page-onboarding" data-page="onboarding">
      <main class="layout flow-layout">
        <div class="onboarding-content">
          <p class="onboarding-message">STONE 매니저</p>
        </div>
        <div class="flow-bottom-actions">
          <button id="onboardingNext">시작하기</button>
        </div>
      </main>
    </div>
  `;
}

export function bindOnboardingPage(handlers: OnboardingHandlers) {
  const onboardingNext = document.querySelector<HTMLButtonElement>("#onboardingNext");
  onboardingNext?.addEventListener("click", () => {
    handlers.onNext();
  });
}
