type ToggleOptions = {
  id: string;
  className?: string;
  checked?: boolean;
};

export function renderToggle(options: ToggleOptions) {
  const { id, className, checked } = options;
  const classes = ["toggle-switch", className].filter(Boolean).join(" ");
  const checkedAttr = checked ? " checked" : "";
  return `
    <label class="${classes}">
      <input id="${id}" type="checkbox"${checkedAttr} />
      <span class="toggle-track"></span>
    </label>
  `;
}
