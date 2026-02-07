type SectionOptions = {
  title: string;
  body: string;
  className?: string;
};

export function renderSection(options: SectionOptions) {
  const { title, body, className } = options;
  const classes = ["section", className].filter(Boolean).join(" ");
  return `
    <section class="${classes}">
      <h2>${title}</h2>
      ${body}
    </section>
  `;
}
