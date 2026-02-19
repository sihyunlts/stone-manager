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
  data?: Record<string, string>;
};

export function renderList(items: string[]) {
  return `<div class="card list-group">${items.join("")}</div>`;
}

export function renderListItem(options: ListItemOptions) {
  const { label, value, valueId, right, body, col, className, id, link, data } = options;
  const isCol = Boolean(col || body);
  const labelMarkup = label ? `<div class="list-label">${label}</div>` : "";
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
  const extraData = data
    ? Object.entries(data)
        .map(([key, val]) => ` data-${key}="${val}"`)
        .join("")
    : "";
  const hasValue = valueId !== undefined || value !== undefined;
  const valueContent = value ?? "--";
  const valueMarkup = hasValue
    ? (
      valueId !== undefined
        ? `<div class="list-value" id="${valueId}">${valueContent}</div>`
        : `<div class="list-value">${valueContent}</div>`
    )
    : "";
  const leftMarkup = right && valueMarkup
    ? `<div class="list-main">${labelMarkup}${valueMarkup}</div>`
    : labelMarkup;
  const rowMarkup = right
    ? `<div class="list-item-row">${leftMarkup}${right}</div>`
    : labelMarkup;
  const standaloneValueMarkup = right ? "" : valueMarkup;
  const bodyMarkup = body ? `<div class="list-body">${body}</div>` : "";
  return `
    <div class="${classes}"${idAttr}${dataAttrs}${extraData}>
      ${rowMarkup}
      ${standaloneValueMarkup}
      ${bodyMarkup}
    </div>
  `;
}
