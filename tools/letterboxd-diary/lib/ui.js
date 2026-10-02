const APP = '/plugins/letterboxd-diary/app';
const SETTINGS = '/plugins/letterboxd-diary';
const ROW_LIMIT = 100;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function filmLabel(film) {
  return film.year ? `${film.title} (${film.year})` : film.title;
}

function postButton({ action, label, className = 'ghost', confirm }) {
  return `<form method="post" action="${APP}" class="inline-form"${confirm ? ` onsubmit="return confirm('${escapeHtml(confirm)}')"` : ''}>
    <input type="hidden" name="action" value="${escapeHtml(action)}" />
    <button class="btn ${className}" type="submit">${escapeHtml(label)}</button>
  </form>`;
}

function filmTable(rows, { total, columns }) {
  if (!rows.length) return '<p class="muted">None.</p>';
  const shown = rows.slice(0, ROW_LIMIT);
  const more = (total ?? rows.length) - shown.length;
  return `<table class="table">
      <thead><tr>${columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${shown.map((row) => `<tr>${columns.map((c) => `<td>${c.render(row)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>
    ${more > 0 ? `<p class="muted">And ${more} more.</p>` : ''}`;
}

function letterboxdLink(film) {
  const label = escapeHtml(filmLabel(film));
  return film.uri && /^https:\/\/(letterboxd\.com|boxd\.it)\//i.test(film.uri)
    ? `<a href="${escapeHtml(film.uri)}" target="_blank" rel="noopener">${label}</a>`
    : label;
}

function renderPending(pending) {
  const counts = [
    ['Will mark watched', pending.toMark.length],
    ['Already watched', pending.alreadyWatchedCount],
    ['Not in your libraries', pending.missingCount],
    ['Ambiguous', pending.ambiguousCount],
  ];
  return `<section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">Preview</h2>
        <div class="row-actions quiet">
          ${pending.toMark.length ? postButton({ action: 'apply', label: `Mark ${pending.toMark.length} watched`, className: 'primary', confirm: `Mark ${pending.toMark.length} films watched in Plex?` }) : ''}
          ${postButton({ action: 'discard', label: 'Discard' })}
        </div>
      </div>
      <p class="panel-hint">${escapeHtml(pending.filmCount)} watched films in the export, read ${escapeHtml(pending.createdAt)}. Nothing changes in Plex until you apply. Films already watched in Plex are left alone, and every apply can be undone from tool settings.</p>
      <div class="stat-grid">
        ${counts.map(([label, value]) => `<div class="stat-card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`).join('')}
      </div>
    </section>
    <section class="panel">
      <h2 class="panel-title">Will mark watched</h2>
      ${filmTable(pending.toMark, {
        columns: [
          { label: 'Plex', render: (row) => escapeHtml(filmLabel(row)) },
          { label: 'Letterboxd', render: (row) => escapeHtml(row.letterboxdTitle || '') },
        ],
      })}
    </section>
    <section class="panel">
      <h2 class="panel-title">Ambiguous</h2>
      <p class="panel-hint">More than one film in your libraries has this title and year, so none of them is marked.</p>
      ${filmTable(pending.ambiguous, {
        total: pending.ambiguousCount,
        columns: [
          { label: 'Letterboxd', render: letterboxdLink },
          { label: 'Plex matches', render: (row) => escapeHtml((row.candidates || []).map(filmLabel).join(', ')) },
        ],
      })}
    </section>
    <section class="panel">
      <h2 class="panel-title">Not in your libraries</h2>
      ${filmTable(pending.missing, {
        total: pending.missingCount,
        columns: [{ label: 'Letterboxd', render: letterboxdLink }],
      })}
    </section>`;
}

export function renderHome({ libraryNames, settings, pending, lastCatchUp }) {
  const setup = libraryNames.length
    ? `Movie libraries: ${escapeHtml(libraryNames.join(', '))}.`
    : `<strong>Choose at least one movie library</strong> in <a href="${SETTINGS}">tool settings</a> first.`;
  const catchUp = settings.catchUp
    ? `Catch-up from RSS is on for @${escapeHtml(settings.letterboxdUsername || '?')}. ${lastCatchUp ? `Last check ${escapeHtml(lastCatchUp.at)}: ${escapeHtml(lastCatchUp.message)}` : 'Not checked yet.'}`
    : 'Catch-up from RSS is off.';

  return `<div class="page-header">
      <h1>Letterboxd Diary</h1>
      <p>Mark the films you logged on Letterboxd as watched in Plex.</p>
    </div>
    <section class="panel">
      <p class="panel-hint">${setup} ${catchUp}</p>
    </section>
    ${pending ? renderPending(pending) : ''}
    <section class="panel">
      <h2 class="panel-title">Import export ZIP</h2>
      <p class="panel-hint">Upload the ZIP from Letterboxd Settings → Import &amp; Export. Films from watched.csv and diary.csv are matched to your libraries and shown as a preview first. Ratings alone do not count as a watch.</p>
      <form method="post" action="${APP}" id="diary-import" class="import-row">
        <input type="hidden" name="action" value="preview" />
        <input type="hidden" name="zip_base64" id="zip_base64" />
        <input type="file" id="zip_file" accept=".zip,application/zip" required class="file-input" />
        <button class="btn primary" type="submit">Preview</button>
      </form>
    </section>
    <script>
      document.getElementById('diary-import').addEventListener('submit', function (event) {
        var hidden = document.getElementById('zip_base64');
        if (hidden.value) return;
        var file = document.getElementById('zip_file').files[0];
        if (!file) return;
        event.preventDefault();
        var reader = new FileReader();
        reader.onload = function () {
          hidden.value = String(reader.result || '').split(',')[1] || '';
          event.target.submit();
        };
        reader.readAsDataURL(file);
      });
    </script>`;
}
