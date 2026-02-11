type SelectOption = {
  value: string | number;
  label: string;
};

type SelectOptions = {
  id: string;
  options: SelectOption[];
  value?: string | number;
  className?: string;
  direction?: "up" | "down";
};

type SelectBinding = {
  setValue: (value: string | number, emit?: boolean) => void;
  setOptions: (options: SelectOption[], value?: string | number, emit?: boolean) => void;
};

export function renderSelect(options: SelectOptions) {
  const { id, options: items, value, className, direction = "down" } = options;
  const classes = ["select", className].filter(Boolean).join(" ");
  const currentValue = value !== undefined ? String(value) : String(items[0]?.value ?? "");
  const currentLabel = items.find((item) => String(item.value) === currentValue)?.label ?? "";
  const optionsMarkup = items
    .map((item) => {
      const selected = String(item.value) === currentValue ? " is-selected" : "";
      return `<div class="select-option${selected}" data-value="${item.value}">${item.label}</div>`;
    })
    .join("");
  return `
    <div id="${id}" class="${classes}" data-value="${currentValue}" data-direction="${direction}">
      <button class="select-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
        <span class="select-label">${currentLabel}</span>
        <span class="material-symbols-rounded select-arrow">expand_more</span>
      </button>
      <div class="select-menu" role="listbox">
        ${optionsMarkup}
      </div>
    </div>
  `;
}

export function bindSelect(id: string, onChange: (value: string) => void): SelectBinding | null {
  const root = document.querySelector<HTMLElement>(`#${id}`);
  if (!root) return null;
  const trigger = root.querySelector<HTMLButtonElement>(".select-trigger");
  const menu = root.querySelector<HTMLDivElement>(".select-menu");
  let options = Array.from(root.querySelectorAll<HTMLDivElement>(".select-option"));
  if (!trigger || !menu) return null;

  function setValue(value: string | number, emit = false) {
    const nextValue = String(value);
    root!.dataset.value = nextValue;
    const option = options.find((item) => item.dataset.value === nextValue);
    if (option) {
      const labelEl = trigger!.querySelector(".select-label");
      if (labelEl) labelEl.textContent = option.textContent ?? "";
      options.forEach((item) => item.classList.toggle("is-selected", item === option));
    }
    if (emit) onChange(nextValue);
  }

  function bindOptions() {
    options = Array.from(root!.querySelectorAll<HTMLDivElement>(".select-option"));
    options.forEach((option) => {
      option.addEventListener("click", (event) => {
        event.stopPropagation();
        const value = option.dataset.value;
        if (!value) return;
        setValue(value, true);
        root!.classList.remove("is-open");
        trigger!.setAttribute("aria-expanded", "false");
      });
    });
  }

  function setOptions(items: SelectOption[], value?: string | number, emit = false) {
    const currentValue = value !== undefined ? String(value) : String(items[0]?.value ?? "");
    const optionsMarkup = items
      .map((item) => {
        const selected = String(item.value) === currentValue ? " is-selected" : "";
        return `<div class="select-option${selected}" data-value="${item.value}">${item.label}</div>`;
      })
      .join("");
    menu!.innerHTML = optionsMarkup;
    bindOptions();
    setValue(currentValue, emit);
  }

  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    document.querySelectorAll<HTMLElement>(".select.is-open").forEach((openSelect) => {
      if (openSelect === root) return;
      openSelect.classList.remove("is-open");
      const openTrigger = openSelect.querySelector<HTMLButtonElement>(".select-trigger");
      if (openTrigger) openTrigger.setAttribute("aria-expanded", "false");
    });
    const direction = root.dataset.direction ?? "down";
    root.classList.toggle("is-up", direction === "up");
    root.classList.toggle("is-down", direction === "down");
    const open = root.classList.toggle("is-open");
    if (open) {
      menu.style.left = "";
      menu.style.right = "";
      requestAnimationFrame(() => {
        const container = root.closest<HTMLElement>(".layout");
        const containerRect = container?.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        if (containerRect) {
          const overflowRight = menuRect.right > containerRect.right - 8;
          const overflowLeft = menuRect.left < containerRect.left + 8;
          if (overflowRight && !overflowLeft) {
            menu.style.left = "auto";
            menu.style.right = "0";
          } else if (overflowLeft && !overflowRight) {
            menu.style.left = "0";
            menu.style.right = "auto";
          }
        }
      });
    }
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  });

  bindOptions();
  document.addEventListener("click", () => {
    if (!root.classList.contains("is-open")) return;
    root.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    menu.style.left = "";
    menu.style.right = "";
  });

  return { setValue, setOptions };
}
