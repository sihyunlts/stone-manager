type ListItemOptions = {
  label: string;
  value?: string;
  valueId?: string;
  right?: string;
  className?: string;
  id?: string;
};

export function renderList(items: string[]) {
  return `<div class="card list-group">${items.join("")}</div>`;
}

export function renderListItem(options: ListItemOptions) {
  const { label, value, valueId, right, className, id } = options;
  const classes = ["list-item", right ? "list-item--row" : "", className]
    .filter(Boolean)
    .join(" ");
  const idAttr = id ? ` id="${id}"` : "";
  const valueContent = value ?? "--";
  const valueMarkup =
    valueId !== undefined
      ? `<div class="list-value" id="${valueId}">${valueContent}</div>`
      : value !== undefined
        ? `<div class="list-value">${valueContent}</div>`
        : "";
  if (right) {
    return `
      <div class="${classes}"${idAttr}>
        <div class="list-label">${label}</div>
        ${right}
      </div>
    `;
  }
  return `
    <div class="${classes}"${idAttr}>
      <div class="list-label">${label}</div>
      ${valueMarkup}
    </div>
  `;
}
