function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function filmLabel(film) {
  return film.year ? `${film.title} (${film.year})` : film.title;
}

/**
 * @param {Array<{ title: string, url: string, owned: number, total: number, missing: Array<{ title: string, year: number|null, link: string }> }>} lists
 */
export function buildMissingEmail(lists) {
  const subject = lists.length === 1
    ? `Letterboxd list update: ${lists[0].title}`
    : `Letterboxd list updates: ${lists.length} lists`;

  const text = lists
    .map((list) => {
      const head = `${list.title}: you have ${list.owned} of ${list.total} films`;
      if (!list.missing.length) return `${head}. Nothing missing.`;
      return [`${head}. Missing:`, ...list.missing.map((film) => `- ${filmLabel(film)} ${film.link}`)].join('\n');
    })
    .join('\n\n');

  const html = `<div style="font-family:system-ui,sans-serif;max-width:640px">
${lists
  .map((list) => {
    const items = list.missing.length
      ? `<ul>${list.missing.map((film) => `<li><a href="${escapeHtml(film.link)}">${escapeHtml(filmLabel(film))}</a></li>`).join('')}</ul>`
      : '<p>Nothing missing.</p>';
    return `<h2 style="font-size:1.1rem;margin:1.2rem 0 0.3rem"><a href="${escapeHtml(list.url)}">${escapeHtml(list.title)}</a></h2>
<p style="margin:0;color:#555">You have ${escapeHtml(list.owned)} of ${escapeHtml(list.total)} films.</p>
${items}`;
  })
  .join('\n')}
</div>`;

  return { subject, text, html };
}
