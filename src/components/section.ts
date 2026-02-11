type SectionOptions = {
  title: string;
  body: string;
  className?: string;
  id?: string;
};

export function renderSection(options: SectionOptions) {
  const { title, body, className, id } = options;
  const classes = ["section", className].filter(Boolean).join(" ");
  const idAttr = id ? ` id="${id}"` : "";
  return `
    <section class="${classes}"${idAttr}>
      <h2>${title}</h2>
      ${body}
    </section>
  `;
}
