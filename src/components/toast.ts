import { animate } from "motion";
import stoneImg from "../assets/stone.png";
import { renderButton } from "./button";

type ToastHandle = {
  show: (name: string) => void;
  hide: () => void;
};

export function initToast(host: HTMLElement): ToastHandle {
  const wrapper = document.createElement("div");
  wrapper.id = "toast";
  wrapper.className = "toast";
  wrapper.innerHTML = `
    <div class="toast-card">
      <div class="toast-title" id="toastTitle">STONE</div>
      <img src="${stoneImg}" class="toast-image" alt="STONE" />
      <div class="toast-subtitle">새로운 기기가 등록되었습니다.</div>
      ${renderButton({ id: "toastConfirm", text: "확인", tone: "primary" })}
    </div>
  `;
  host.appendChild(wrapper);

  const title = wrapper.querySelector<HTMLElement>("#toastTitle");
  const card = wrapper.querySelector<HTMLElement>(".toast-card");
  const confirmBtn = wrapper.querySelector<HTMLButtonElement>("#toastConfirm");

  function hide() {
    animate(wrapper, { background: "rgba(0, 0, 0, 0)" } as any, { duration: 0.2 });
    animate(card!, { opacity: 0 } as any, { duration: 0.2 });
    animate(
      card!,
      { y: 40 } as any,
      { duration: 0.3, easing: "ease-in" } as any
    ).then(() => {
      wrapper.classList.remove("is-visible");
      wrapper.style.opacity = "0";
    });
  }

  function show(name: string) {
    if (title) {
      title.textContent = name;
    }
    wrapper.style.opacity = "1";
    wrapper.classList.add("is-visible");

    animate(wrapper, { background: "rgba(0, 0, 0, 0.3)" } as any, { duration: 0.4 });
    animate(card!, { opacity: [0, 1] } as any, { duration: 0.2, easing: "ease-out" } as any);
    animate(
      card!,
      { y: [40, 0] } as any,
      {
        type: "spring",
        stiffness: 300,
        damping: 25,
        mass: 0.4
      } as any
    );
  }

  confirmBtn?.addEventListener("click", hide);

  return { show, hide };
}
