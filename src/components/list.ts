type ListItemOptions = {
  label?: string;
  value?: string;
  valueId?: string;
  right?: string;
  body?: string;
  col?: boolean;
  className?: string;
  id?: string;
  link?: { url: string };
};

export function renderList(items: string[]) {
  return `<div class="card list-group">${items.join("")}</div>`;
}

export function renderListItem(options: ListItemOptions) {
  const { label, value, valueId, right, body, col, className, id, link } = options;
  const isCol = Boolean(col || body);
  const labelMarkup = label ? `<div class="list-label">${label}</div>` : "";
  const rowMarkup = right
    ? `<div class="list-item-row">${labelMarkup}${right}</div>`
    : labelMarkup;
  const classes = [
    "list-item",
    isCol ? "list-item--col" : "",
    link || id ? "clickable" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const idAttr = id ? ` id="${id}"` : "";
  const dataAttrs = link ? ` data-url="${link.url}"` : "";
  const valueContent = value ?? "--";
  const valueMarkup =
    valueId !== undefined
      ? `<div class="list-value" id="${valueId}">${valueContent}</div>`
      : value !== undefined
        ? `<div class="list-value">${valueContent}</div>`
        : "";
  const bodyMarkup = body ? `<div class="list-body">${body}</div>` : "";
  return `
    <div class="${classes}"${idAttr}${dataAttrs}>
      ${rowMarkup}
      ${valueMarkup}
      ${bodyMarkup}
    </div>
  `;
}
