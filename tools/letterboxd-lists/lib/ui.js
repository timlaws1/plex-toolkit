const APP = '/plugins/letterboxd-lists/app';
const SETTINGS = '/plugins/letterboxd-lists';
const ROW_LIMIT = 100;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function filmLink(film) {
  const label = escapeHtml(film.year ? `${film.title} (${film.year})` : film.title);
  return /^https:\/\/letterboxd\.com\//i.test(film.link || '')
    ? `<a href="${escapeHtml(film.link)}" target="_blank" rel="noopener">${label}</a>`
    : label;
}

function filmList(films, total) {
  if (!films?.length) return '<p class="muted">None.</p>';
  const shown = films.slice(0, ROW_LIMIT);
  const more = (total ?? films.length) - shown.length;
  return `<table class="table"><tbody>${shown.map((film) => `<tr><td>${filmLink(film)}</td></tr>`).join('')}</tbody></table>
    ${more > 0 ? `<p class="muted">And ${more} more.</p>` : ''}`;
}

function renderList(list, libraryNames) {
  const state = list.state;
  if (list.error && !state) {
    return `<section class="panel">
        <h2 class="panel-title">${escapeHtml(list.url)}</h2>
        <p class="badge err">${escapeHtml(list.error)}</p>
      </section>`;
  }
  if (!state) {
    return `<section class="panel">
        <h2 class="panel-title"><a href="${escapeHtml(list.url)}" target="_blank" rel="noopener">${escapeHtml(list.url)}</a></h2>
        <p class="muted">Not synced yet.</p>
      </section>`;
  }
  const collections = Object.entries(state.collections || {})
    .filter(([, value]) => value?.key)
    .map(([sectionId]) => libraryNames.get(sectionId) || `Library ${sectionId}`);
  return `<section class="panel">
      <h2 class="panel-title"><a href="${escapeHtml(list.url)}" target="_blank" rel="noopener">${escapeHtml(state.title || list.url)}</a></h2>
      <p class="panel-hint">You have ${escapeHtml(state.owned)} of ${escapeHtml(state.total)} films.
        ${collections.length ? `Collection in ${escapeHtml(collections.join(', '))}.` : 'No collection yet: none of the films are in your libraries.'}
        ${state.watchlistAdded ? `${escapeHtml(state.watchlistAdded)} added to your watchlist on the last sync.` : ''}
        Synced ${escapeHtml(state.syncedAt || 'never')}.</p>
      ${state.error ? `<p class="badge err">Last sync failed: ${escapeHtml(state.error)}</p>` : ''}
      <h3>Missing (${escapeHtml(state.missingCount ?? 0)})</h3>
      ${filmList(state.missing, state.missingCount)}
      ${state.ambiguousCount ? `<h3>Ambiguous (${escapeHtml(state.ambiguousCount)})</h3>
        <p class="panel-hint">More than one film in a library has this title and year, so none was added.</p>
        ${filmList(state.ambiguous, state.ambiguousCount)}` : ''}
    </section>`;
}

export function renderHome({ lists, libraryNames, hasLibraries, lastRun }) {
  const setup = [];
  if (!lists.length) setup.push(`Add list URLs in <a href="${SETTINGS}">tool settings</a>.`);
  if (!hasLibraries) setup.push(`<strong>Choose at least one movie library</strong> in <a href="${SETTINGS}">tool settings</a>.`);
  return `<div class="page-header">
      <h1>Letterboxd Lists</h1>
      <p>Public Letterboxd lists as Plex collections, with the films you are missing.</p>
    </div>
    <section class="panel">
      <div class="panel-head">
        <p class="panel-hint">${setup.join(' ') || (lastRun ? `Last sync ${escapeHtml(lastRun.at)}: ${escapeHtml(lastRun.message)}` : 'Not synced yet.')}</p>
        <form method="post" action="${APP}" class="inline-form">
          <input type="hidden" name="action" value="sync" />
          <button class="btn primary" type="submit">Sync now</button>
        </form>
      </div>
    </section>
    ${lists.map((list) => renderList(list, libraryNames)).join('')}`;
}
