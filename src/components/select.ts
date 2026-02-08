type SelectOption = {
  value: string | number;
  label: string;
};

type SelectOptions = {
  id: string;
  options: SelectOption[];
  value?: string | number;
  className?: string;
};

export function renderSelect(options: SelectOptions) {
  const { id, options: items, value, className } = options;
  const classes = ["select", className].filter(Boolean).join(" ");
  const optionsMarkup = items
    .map((item) => {
      const selected = value !== undefined && String(value) === String(item.value) ? " selected" : "";
      return `<option value="${item.value}"${selected}>${item.label}</option>`;
    })
    .join("");
  return `<select id="${id}" class="${classes}">${optionsMarkup}</select>`;
}
