function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatWhen(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

function reasonLabel(m) {
  if (m.reason === 'watchlist') return 'On your watchlist';
  if (m.personName) return `Featuring ${m.personName}`;
  return 'Tracked person';
}

function upcomingList(rows, emptyLabel) {
  if (!rows?.length) {
    return `<div class="listing-empty">${escapeHtml(emptyLabel)}</div>`;
  }
  return `<div class="listing">${rows
    .map((m) => {
      const badge = m.alreadyNotified
        ? '<span class="badge">Sent</span>'
        : '<span class="badge ok">New</span>';
      const also =
        m.alsoOn?.length > 0
          ? `<div class="meta">Also on ${escapeHtml(m.alsoOn.join(' · '))}</div>`
          : '';
      return `<div class="listing-item">
        <div>
          <div class="title">${escapeHtml(m.title)} ${badge}</div>
          <div class="meta">${escapeHtml(m.channel || 'Channel TBA')} · ${escapeHtml(formatWhen(m.startsAt))}</div>
          <div class="meta">${escapeHtml(reasonLabel(m))}</div>
          ${also}
        </div>
      </div>`;
    })
    .join('')}</div>`;
}

function trackForm({ name, tmdbPersonId, profilePath, tab, q, primary, disabled, label }) {
  return `<form method="post" action="/plugins/plex-notifier/app" style="display:inline">
    <input type="hidden" name="action" value="track" />
    <input type="hidden" name="name" value="${escapeHtml(name)}" />
    ${tmdbPersonId != null ? `<input type="hidden" name="tmdbPersonId" value="${escapeHtml(tmdbPersonId)}" />` : '<input type="hidden" name="resolveTmdb" value="1" />'}
    ${profilePath ? `<input type="hidden" name="profilePath" value="${escapeHtml(profilePath)}" />` : ''}
    <input type="hidden" name="tab" value="${escapeHtml(tab)}" />
    <input type="hidden" name="q" value="${escapeHtml(q || '')}" />
    <button type="submit" class="${primary ? 'primary' : ''}" ${disabled ? 'disabled title="Set a TMDB API key in settings first"' : ''}>${escapeHtml(label || 'Follow')}</button>
  </form>`;
}

export function renderApp({
  tab,
  q,
  index,
  searchHits,
  tmdbHits,
  tmdbConfigured,
  tmdbError,
  tracked,
  upcoming,
  pending,
  statusMessage,
}) {
  const tabs = [
    ['actors', 'Actors'],
    ['directors', 'Directors'],
    ['writers', 'Writers'],
    ['genres', 'Genres'],
  ];
  const tabLinks = tabs
    .map(([id, label]) => {
      const active = tab === id ? ' active' : '';
      return `<a class="${active}" href="?tab=${id}${q ? `&q=${encodeURIComponent(q)}` : ''}">${label}</a>`;
    })
    .join('');

  const list =
    tab === 'directors'
      ? index.directors
      : tab === 'writers'
        ? index.writers
        : tab === 'genres'
          ? index.genres
          : index.actors;

  const rankingRows =
    (list || [])
      .slice(0, 15)
      .map(
        (person, i) => `<div class="person-row">
          <div style="display:flex;gap:0.65rem;align-items:flex-start;min-width:0">
            <span class="rank-num">${i + 1}</span>
            <div style="min-width:0">
              <div class="name">${escapeHtml(person.name)}</div>
              <div class="sub">${person.titleCount} title${person.titleCount === 1 ? '' : 's'} in your history</div>
            </div>
          </div>
          ${
            tab === 'genres'
              ? ''
              : trackForm({
                  name: person.name,
                  tab,
                  q,
                  disabled: !tmdbConfigured,
                })
          }
        </div>`,
      )
      .join('') || '<p class="muted" style="font-size:0.875rem">No rankings yet. Refresh history first.</p>';

  const localSearchRows = (searchHits || []).map(
    (hit) => `<div class="person-row">
      <div>
        <div class="name">${escapeHtml(hit.name)}</div>
        <div class="sub">From your history · ${escapeHtml(hit.role)}</div>
      </div>
      ${trackForm({ name: hit.name, tab, q, disabled: !tmdbConfigured })}
    </div>`,
  );

  const tmdbRows = (tmdbHits || []).map(
    (hit) => `<div class="person-row">
      <div>
        <div class="name">${escapeHtml(hit.name)}</div>
        <div class="sub">${
          hit.knownForDepartment
            ? escapeHtml(hit.knownForDepartment)
            : 'TMDB match'
        }</div>
      </div>
      ${trackForm({
        name: hit.name,
        tmdbPersonId: hit.tmdbPersonId,
        profilePath: hit.profilePath,
        tab,
        q,
        primary: true,
      })}
    </div>`,
  );

  let searchBody = '';
  if (q) {
    if (tmdbError) {
      searchBody = `<p class="muted" style="margin-top:0.75rem">${escapeHtml(tmdbError)}</p>`;
    } else if (tmdbRows.length || localSearchRows.length) {
      searchBody = `<div class="person-list" style="margin-top:0.75rem">${tmdbRows.join('')}${localSearchRows.join('')}</div>`;
    } else {
      searchBody = `<p class="muted" style="margin-top:0.75rem">No people matched “${escapeHtml(q)}”.</p>`;
    }
  }

  const trackedRows =
    (tracked || [])
      .map((p) => {
        const ok = Number(p.tmdbPersonId) > 0;
        return `<div class="person-row">
          <div>
            <div class="name">${escapeHtml(p.name)}</div>
            <div class="sub">${ok ? 'Ready to match Freeview' : 'Needs re-follow via search'}</div>
          </div>
          <form method="post" action="/plugins/plex-notifier/app" style="display:inline">
            <input type="hidden" name="action" value="untrack" />
            <input type="hidden" name="nameKey" value="${escapeHtml(p.nameKey)}" />
            <input type="hidden" name="tab" value="${escapeHtml(tab)}" />
            <button class="ghost danger" type="submit">Remove</button>
          </form>
        </div>`;
      })
      .join('') ||
    '<p class="muted" style="font-size:0.875rem">Nobody yet. Search or follow someone from rankings.</p>';

  const movies = (upcoming || []).filter((m) => m.mediaType === 'movie');
  const tv = (upcoming || []).filter((m) => m.mediaType === 'tv');
  const other = (upcoming || []).filter(
    (m) => m.mediaType !== 'movie' && m.mediaType !== 'tv',
  );

  const pendingNote =
    pending?.length > 0
      ? `<p class="muted" style="margin-top:0.75rem">${pending.length} item${pending.length === 1 ? '' : 's'} waiting in the digest queue.</p>`
      : '';

  const stats = index.stats || {};
  const updated = index.updatedAt
    ? new Date(index.updatedAt).toLocaleString()
    : 'never';

  const historyLine = `History updated ${escapeHtml(updated)} · ${stats.watchedMovies || 0} movies watched · ${stats.watchedShows || 0} shows with plays`;

  const tmdbNote = tmdbConfigured
    ? '<p class="field-help">Search TMDB, follow someone, then run a Freeview match.</p>'
    : '<p class="field-help">Add a <strong>TMDB API key</strong> in settings to search and follow people.</p>';

  return `
    <div class="page-header">
      <h1>Plex Notifier</h1>
      <p>See what’s on Freeview that matches your watchlist and the people you follow.</p>
    </div>
    ${statusMessage ? `<div class="panel" style="margin-bottom:1rem"><p>${escapeHtml(statusMessage)}</p></div>` : ''}

    <div class="pn-layout">
      <div class="pn-main">
        <div class="panel">
          <p class="pn-status">${historyLine}</p>
          <div class="pn-actions">
            <form method="post" action="/plugins/plex-notifier/app" style="display:inline">
              <input type="hidden" name="action" value="match" />
              <button class="primary" type="submit">Run Freeview match</button>
            </form>
            <form method="post" action="/plugins/plex-notifier/app" style="display:inline">
              <input type="hidden" name="action" value="digest" />
              <button type="submit" class="ghost">Send digest</button>
            </form>
            <form method="post" action="/plugins/plex-notifier/app" style="display:inline">
              <input type="hidden" name="action" value="watchlist" />
              <button type="submit" class="ghost">Sync watchlist</button>
            </form>
            <form method="post" action="/plugins/plex-notifier/app" style="display:inline">
              <input type="hidden" name="action" value="refresh" />
              <button type="submit" class="ghost">Refresh history</button>
            </form>
          </div>
          ${pendingNote}
        </div>

        <div class="panel">
          <h2 class="panel-title">Movies this week</h2>
          <p class="panel-hint">Matched movie airings in your notify window.</p>
          ${upcomingList(movies, 'No movie matches right now.')}
        </div>

        <div class="panel">
          <h2 class="panel-title">TV this week</h2>
          <p class="panel-hint">Matched TV airings in your notify window.</p>
          ${upcomingList(tv, 'No TV matches right now.')}
        </div>

        ${
          other.length
            ? `<div class="panel">
          <h2 class="panel-title">Other</h2>
          ${upcomingList(other, '')}
        </div>`
            : ''
        }
      </div>

      <aside class="pn-sidebar">
        <div class="panel">
          <h2 class="panel-title">Search people</h2>
          ${tmdbNote}
          <form method="get" action="/plugins/plex-notifier/app">
            <input type="hidden" name="tab" value="${escapeHtml(tab)}" />
            <div class="field">
              <label for="q">Name</label>
              <input id="q" type="search" name="q" value="${escapeHtml(q || '')}" placeholder="e.g. Cary Grant" />
            </div>
            <div class="row-actions">
              <button type="submit" ${tmdbConfigured ? '' : 'disabled'}>Search</button>
            </div>
          </form>
          ${searchBody}
        </div>

        <div class="panel">
          <h2 class="panel-title">People you follow</h2>
          <div class="person-list">${trackedRows}</div>
        </div>

        <div class="panel">
          <h2 class="panel-title">From your watching</h2>
          <p class="panel-hint">Ranked from Plex watch history.</p>
          <div class="tabs">${tabLinks}</div>
          <div class="person-list">${rankingRows}</div>
        </div>
      </aside>
    </div>
  `;
}
