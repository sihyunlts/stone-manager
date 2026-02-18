type ButtonType = "button" | "submit" | "reset";
type ButtonKind = "default" | "icon";
type ButtonTone = "primary" | "secondary" | "danger";
type ButtonAttributeValue = string | number | boolean | null | undefined;

type ButtonOptions = {
  id?: string;
  className?: string;
  text?: string;
  html?: string;
  type?: ButtonType;
  kind?: ButtonKind;
  tone?: ButtonTone;
  attrs?: Record<string, ButtonAttributeValue>;
};

function escapeAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toAttribute(name: string, value: ButtonAttributeValue) {
  if (value === null || value === undefined || value === false) return "";
  if (value === true) return ` ${name}`;
  return ` ${name}="${escapeAttribute(String(value))}"`;
}

export function renderButton(options: ButtonOptions) {
  const {
    id,
    className,
    text,
    html,
    type = "button",
    kind = "default",
    tone = "primary",
    attrs,
  } = options;
  const content = html ?? text ?? "";
  const classes = ["btn", `btn--kind-${kind}`, `btn--tone-${tone}`, className]
    .filter(Boolean)
    .join(" ");

  let attributes = "";
  attributes += toAttribute("type", type);
  attributes += toAttribute("id", id);
  attributes += toAttribute("class", classes);

  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      attributes += toAttribute(name, value);
    }
  }

  return `<button${attributes}>${content}</button>`;
}
