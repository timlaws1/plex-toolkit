import { formatWhen, nextRunDate, parseDays, PRESETS, WEEKDAYS } from './schedule.js';

const APP = '/plugins/scheduled-recommendations/app';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pageHeader(title, subtitle) {
  return `<div class="page-header">
    <h1>${escapeHtml(title)}</h1>
    ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
  </div>`;
}

export function renderHome({ schedules, lastRuns, importInfo, filmCount }) {
  const rows = schedules.length
    ? schedules.map((schedule) => {
      const last = lastRuns.get(schedule.id);
      const upcoming = nextRunDate(schedule, new Date());
      const nextLabel = Number(schedule.enabled)
        ? (upcoming ? upcoming.toLocaleString() : 'Due')
        : '—';
      return `<tr>
        <td>${escapeHtml(schedule.name)}</td>
        <td>${escapeHtml(formatWhen(schedule))}</td>
        <td>${escapeHtml(nextLabel)}</td>
        <td>${escapeHtml(schedule.film_count)}</td>
        <td>${escapeHtml(schedule.output_type)}</td>
        <td>${Number(schedule.enabled) ? 'On' : 'Off'}</td>
        <td>${last ? escapeHtml(last.created_at) : '—'}</td>
        <td class="row-actions">
          <a class="btn ghost" href="${APP}?edit=${schedule.id}">Edit</a>
          <form method="post" action="${APP}" style="display:inline">
            <input type="hidden" name="action" value="run" />
            <input type="hidden" name="id" value="${schedule.id}" />
            <button class="btn ghost" type="submit">Run now</button>
          </form>
          <form method="post" action="${APP}" style="display:inline">
            <input type="hidden" name="action" value="toggle" />
            <input type="hidden" name="id" value="${schedule.id}" />
            <button class="btn ghost" type="submit">${Number(schedule.enabled) ? 'Disable' : 'Enable'}</button>
          </form>
          <form method="post" action="${APP}" style="display:inline" onsubmit="return confirm('Delete this schedule?')">
            <input type="hidden" name="action" value="delete" />
            <input type="hidden" name="id" value="${schedule.id}" />
            <button class="btn ghost" type="submit">Delete</button>
          </form>
        </td>
      </tr>`;
    }).join('')
    : '<tr><td colspan="8" class="muted">No schedules yet.</td></tr>';

  const importLine = importInfo
    ? `Last import: ${importInfo.film_count} films at ${importInfo.finished_at}${importInfo.error ? ` (${importInfo.error})` : ''}.`
    : 'No Letterboxd export imported yet.';

  return `${pageHeader('Recommendations', 'Plex stays the interface. Toolkit picks the films.')}
    <section class="panel">
      <h2 class="panel-title">Schedules</h2>
      <div class="row-actions" style="margin-bottom:0.75rem">
        <a class="btn primary" href="${APP}?new=1">Create schedule</a>
        <a class="btn" href="${APP}?new=1&amp;preset=tonight">Tonight</a>
        <a class="btn" href="${APP}?new=1&amp;preset=film-night">Film Night</a>
        <a class="btn" href="${APP}?new=1&amp;preset=every-night">One Film Every Night</a>
        <a class="btn" href="${APP}?new=1&amp;preset=weekend">Weekend Films</a>
      </div>
      <table class="data">
        <thead><tr><th>Name</th><th>Frequency</th><th>Next run</th><th>Films</th><th>Output</th><th></th><th>Last run</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
    <section class="panel">
      <h2 class="panel-title">Letterboxd</h2>
      <p>${escapeHtml(importLine)} ${filmCount} films stored.</p>
      <p class="muted">Upload the ZIP from Letterboxd Settings → Import &amp; Export. RSS in tool settings keeps taste current after that. Plex account Lists are not available through a supported API, so streaming titles go to your Plex watchlist.</p>
      <form method="post" action="${APP}" id="letterboxd-import">
        <input type="hidden" name="action" value="import" />
        <input type="hidden" name="zip_base64" id="zip_base64" />
        <label class="field">Export ZIP <input type="file" id="zip_file" accept=".zip,application/zip" required /></label>
        <button class="btn primary" type="submit">Import</button>
      </form>
    </section>
    <script>
      document.getElementById('letterboxd-import').addEventListener('submit', function (event) {
        var hidden = document.getElementById('zip_base64');
        if (hidden.value) return;
        var file = document.getElementById('zip_file').files[0];
        if (!file) return;
        event.preventDefault();
        var reader = new FileReader();
        reader.onload = function () {
          var text = String(reader.result || '');
          hidden.value = text.split(',')[1] || '';
          event.target.submit();
        };
        reader.readAsDataURL(file);
      });
    </script>`;
}

export function renderForm({ schedule, libraries, preset }) {
  const days = parseDays(schedule.days);
  const dayBoxes = WEEKDAYS.map((day) => `
    <label><input type="checkbox" name="day_${day.id}" value="1" ${days.includes(day.id) ? 'checked' : ''} /> ${day.label}</label>
  `).join(' ');
  const movieLibs = libraries.filter((lib) => lib.type === 'movie');
  const options = movieLibs.map((lib) => `
    <option value="${escapeHtml(lib.id)}" ${String(schedule.plex_section_id || '') === String(lib.id) ? 'selected' : ''}>${escapeHtml(lib.title)}</option>
  `).join('');
  const action = schedule.id ? `${APP}?edit=${schedule.id}` : APP;
  return `${pageHeader(schedule.id ? 'Edit schedule' : 'Create schedule', preset ? `Preset: ${preset}` : '')}
    <form method="post" action="${action}" class="panel">
      <input type="hidden" name="action" value="save" />
      <input type="hidden" name="preset" value="${escapeHtml(schedule.preset || '')}" />
      <label class="field">Name <input name="name" required value="${escapeHtml(schedule.name || '')}" /></label>
      <label class="field"><input type="checkbox" name="enabled" value="1" ${Number(schedule.enabled) ? 'checked' : ''} /> Enabled</label>
      <fieldset class="field"><legend>When?</legend>${dayBoxes}
        <input type="time" name="time_local" value="${escapeHtml(schedule.time_local || '18:00')}" />
      </fieldset>
      <label class="field">How many films? <input name="film_count" type="number" min="1" max="10" value="${escapeHtml(schedule.film_count || 1)}" /></label>
      <div class="field-grid">
        <label class="field">Minimum minutes <input name="runtime_min" type="number" value="${escapeHtml(schedule.runtime_min ?? '')}" /></label>
        <label class="field">Maximum minutes <input name="runtime_max" type="number" value="${escapeHtml(schedule.runtime_max ?? '')}" /></label>
      </div>
      <label class="field"><input type="checkbox" name="allow_streaming" value="1" ${Number(schedule.allow_streaming) ? 'checked' : ''} /> Include streaming titles when the output is the Plex watchlist</label>
      <label class="field"><input type="checkbox" name="prefer_plex" value="1" ${schedule.prefer_plex == null || Number(schedule.prefer_plex) ? 'checked' : ''} /> Prefer films already in Plex</label>
      <label class="field">Genres <input name="genres" value="${escapeHtml(schedule.genres || '')}" placeholder="Comedy, Drama" /></label>
      <label class="field">Output
        <select name="output_type">
          ${['collection', 'playlist', 'watchlist'].map((output) => `<option value="${output}" ${schedule.output_type === output ? 'selected' : ''}>${output}</option>`).join('')}
        </select>
      </label>
      <label class="field">Movie library
        <select name="plex_section_id"><option value="">—</option>${options}</select>
      </label>
      <details>
        <summary>More</summary>
        <label class="field">Excluded genres <input name="excluded_genres" value="${escapeHtml(schedule.excluded_genres || '')}" /></label>
        <label class="field">Minimum public rating (0–10) <input name="rating_min" value="${escapeHtml(schedule.rating_min ?? '')}" /></label>
        <label class="field">Maximum public rating (0–10) <input name="rating_max" value="${escapeHtml(schedule.rating_max ?? '')}" /></label>
        <label class="field"><input type="checkbox" name="replace_on_watch" value="1" ${schedule.replace_on_watch == null || Number(schedule.replace_on_watch) ? 'checked' : ''} /> Replace a film after it is watched</label>
        <label class="field"><input type="checkbox" name="remove_watchlist" value="1" ${Number(schedule.remove_watchlist) ? 'checked' : ''} /> Remove watched films from the Plex watchlist</label>
      </details>
      <p class="muted">Collections and playlists only include films in your Plex library. Account Lists are not available through a supported Plex API.</p>
      <button class="btn primary" type="submit">Save</button>
      <a class="btn ghost" href="${APP}">Cancel</a>
    </form>`;
}

export function blankSchedule(presetKey) {
  const preset = PRESETS[presetKey] || {};
  return {
    name: preset.name || '',
    enabled: 1,
    days: JSON.stringify(preset.days || [5]),
    time_local: preset.time || '18:00',
    film_count: preset.count || 1,
    runtime_min: preset.runtimeMin ?? '',
    runtime_max: preset.runtimeMax ?? '',
    allow_streaming: preset.allowStreaming ? 1 : 0,
    prefer_plex: preset.preferPlex === false ? 0 : 1,
    genres: preset.genres || '',
    excluded_genres: '',
    output_type: preset.output || 'collection',
    replace_on_watch: 1,
    remove_watchlist: 0,
    preset: presetKey || '',
  };
}
