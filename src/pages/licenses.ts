import { renderHeader } from "../components/header";
import { renderList, renderListItem } from "../components/list";
import licenseData from "../assets/licenses.json";

export function renderLicensesPage() {
  const items = licenseData.map((lib: any) => {
    let url = lib.homepage;
    if (!url && lib.repository) {
      url = typeof lib.repository === 'string' ? lib.repository : lib.repository.url;
    }

    return renderListItem({
      label: lib.name,
      className: "license-item",
      link: url ? { url } : undefined
    });
  });

  return `
    <div class="page" id="page-licenses" data-page="licenses">
      ${renderHeader({ title: "오픈소스 라이선스", showBack: true })}
      <main class="layout">
        <section>
          ${renderList(items)}
        </section>
      </main>
    </div>
  `;
}
