import { whereToWatch } from './email.js';
import { CERTIFICATES } from './ratings.js';
import { effectiveOutput, formatWhen, nextRunDate, OUTPUTS, parseDays, PRESETS, WEEKDAYS } from './schedule.js';
import { STREAMING_SERVICES } from './services.js';

const APP = '/plugins/scheduled-recommendations/app';
const SETTINGS = '/plugins/scheduled-recommendations';

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

function outputLabel(schedule) {
  const output = effectiveOutput(schedule);
  return OUTPUTS.find((row) => row.id === output)?.label || output;
}

function capLabel(cap) {
  return cap ? `Up to ${cap}` : 'Any age rating';
}

function serviceLabels(ids) {
  const selected = new Set(ids || []);
  return STREAMING_SERVICES.filter((service) => selected.has(service.id)).map((service) => service.label);
}

function postButton({ action, id, label, className = 'ghost', confirm }) {
  return `<form method="post" action="${APP}" class="inline-form"${confirm ? ` onsubmit="return confirm('${escapeHtml(confirm)}')"` : ''}>
    <input type="hidden" name="action" value="${escapeHtml(action)}" />
    <input type="hidden" name="id" value="${escapeHtml(id)}" />
    <button class="btn ${className}" type="submit">${escapeHtml(label)}</button>
  </form>`;
}

function setupStrip({ setup }) {
  const services = serviceLabels(setup.services);
  const items = [
    {
      ok: setup.films > 0,
      title: 'Letterboxd',
      text: setup.films > 0 ? `${setup.films} films` : 'Import your export below',
    },
    {
      ok: setup.tmdb,
      title: 'TMDb',
      text: setup.tmdb ? 'Connected' : 'Add a key in settings',
      href: setup.tmdb ? null : SETTINGS,
    },
    {
      ok: services.length > 0,
      title: 'Streaming',
      text: services.length ? services.slice(0, 3).join(', ') + (services.length > 3 ? ` +${services.length - 3}` : '') : 'Pick your services',
      href: SETTINGS,
    },
    {
      ok: setup.mail,
      title: 'Email',
      text: setup.mail ? 'Ready' : 'Set up on the Mail page',
      href: setup.mail ? null : '/mail',
    },
  ];
  return `<div class="setup-strip">
    ${items.map((item) => {
      const inner = `<span class="setup-dot ${item.ok ? 'ok' : 'warn'}"></span>
        <span><strong>${escapeHtml(item.title)}</strong><span class="muted">${escapeHtml(item.text)}</span></span>`;
      return item.href
        ? `<a class="setup-item" href="${item.href}">${inner}</a>`
        : `<div class="setup-item">${inner}</div>`;
    }).join('')}
  </div>`;
}

export function renderHome({ schedules, lastRuns, importInfo, filmCount, setup }) {
  const cards = schedules.length
    ? schedules.map((schedule) => {
      const last = lastRuns.get(schedule.id);
      const enabled = Number(schedule.enabled) === 1;
      const upcoming = enabled ? nextRunDate(schedule, new Date()) : null;
      const nextLabel = enabled ? (upcoming ? upcoming.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Due now') : 'Paused';
      const streaming = Number(schedule.allow_streaming) === 1;
      return `<article class="schedule-card${enabled ? '' : ' is-off'}">
        <div class="schedule-card-head">
          <div>
            <h3>${escapeHtml(schedule.name)}</h3>
            <div class="schedule-meta">
              <span>${escapeHtml(formatWhen(schedule))}</span>
              <span>${escapeHtml(schedule.film_count)} film${Number(schedule.film_count) === 1 ? '' : 's'}</span>
              <span>${escapeHtml(outputLabel(schedule))}</span>
              <span>${escapeHtml(capLabel(schedule.certificate_max))}</span>
              <span>${streaming ? 'Plex + streaming' : 'Plex only'}</span>
            </div>
          </div>
          <span class="badge ${enabled ? 'ok' : ''}">${enabled ? 'On' : 'Off'}</span>
        </div>
        <div class="schedule-card-foot">
          <div class="schedule-runs muted">
            <span>Next: ${escapeHtml(nextLabel)}</span>
            <span>Last: ${last ? escapeHtml(last.created_at) + (last.message ? ` · ${escapeHtml(last.message)}` : '') : 'never'}</span>
          </div>
          <div class="row-actions quiet">
            <a class="btn primary" href="${APP}?test=${schedule.id}">Test</a>
            ${postButton({ action: 'run', id: schedule.id, label: 'Run now', className: '' })}
            <a class="btn ghost" href="${APP}?edit=${schedule.id}">Edit</a>
            ${postButton({ action: 'toggle', id: schedule.id, label: enabled ? 'Pause' : 'Resume' })}
            ${postButton({ action: 'delete', id: schedule.id, label: 'Delete', confirm: 'Delete this schedule?' })}
          </div>
        </div>
      </article>`;
    }).join('')
    : `<div class="empty-state">
        <strong>No schedules yet</strong>
        <p class="muted">Start from a preset or build your own.</p>
      </div>`;

  const importLine = importInfo
    ? `Last import: ${importInfo.film_count} films at ${importInfo.finished_at}${importInfo.error ? ` (${importInfo.error})` : ''}.`
    : 'No Letterboxd export imported yet.';

  return `${pageHeader('Recommendations', 'Films picked from your Letterboxd taste, added to Plex or emailed to you on a schedule.')}
    ${setupStrip({ setup })}
    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">Schedules</h2>
        <a class="btn primary" href="${APP}?new=1">New schedule</a>
      </div>
      <div class="preset-row">
        <span class="muted">Presets:</span>
        <a class="btn ghost" href="${APP}?new=1&amp;preset=tonight">Tonight</a>
        <a class="btn ghost" href="${APP}?new=1&amp;preset=film-night">Film Night</a>
        <a class="btn ghost" href="${APP}?new=1&amp;preset=every-night">One Film Every Night</a>
        <a class="btn ghost" href="${APP}?new=1&amp;preset=weekend">Weekend Films</a>
      </div>
      <div class="schedule-list">${cards}</div>
    </section>
    <section class="panel">
      <h2 class="panel-title">Letterboxd</h2>
      <p class="panel-hint">${escapeHtml(importLine)} ${escapeHtml(filmCount)} films stored. Upload the ZIP from Letterboxd Settings → Import &amp; Export. The RSS feed in tool settings keeps your taste current after that.</p>
      <form method="post" action="${APP}" id="letterboxd-import" class="import-row">
        <input type="hidden" name="action" value="import" />
        <input type="hidden" name="zip_base64" id="zip_base64" />
        <input type="file" id="zip_file" accept=".zip,application/zip" required class="file-input" />
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

function toggle(name, checked, title, help) {
  return `<label class="toggle-row">
    <span class="toggle-copy">
      <strong>${escapeHtml(title)}</strong>
      ${help ? `<span>${help}</span>` : ''}
    </span>
    <input type="checkbox" name="${escapeHtml(name)}" value="1" ${checked ? 'checked' : ''} />
  </label>`;
}

function numberField(name, label, value, attrs = '') {
  return `<div class="field">
    <label for="f-${name}">${escapeHtml(label)}</label>
    <input id="f-${name}" name="${name}" type="number" ${attrs} value="${escapeHtml(value ?? '')}" />
  </div>`;
}

function textField(name, label, value, placeholder = '') {
  return `<div class="field">
    <label for="f-${name}">${escapeHtml(label)}</label>
    <input id="f-${name}" name="${name}" type="text" value="${escapeHtml(value ?? '')}" placeholder="${escapeHtml(placeholder)}" />
  </div>`;
}

export function renderForm({ schedule, libraries, preset, services }) {
  const days = parseDays(schedule.days);
  const dayPicks = WEEKDAYS.map((day) => `
    <label class="day-pick"><input type="checkbox" name="day_${day.id}" value="1" ${days.includes(day.id) ? 'checked' : ''} /><span>${day.label}</span></label>
  `).join('');
  const movieLibs = libraries.filter((lib) => lib.type === 'movie');
  const libraryOptions = movieLibs.map((lib) => `
    <option value="${escapeHtml(lib.id)}" ${String(schedule.plex_section_id || '') === String(lib.id) ? 'selected' : ''}>${escapeHtml(lib.title)}</option>
  `).join('');
  const streaming = Number(schedule.allow_streaming) === 1;
  const output = effectiveOutput(schedule);
  const outputOptions = OUTPUTS.map((row) => `
    <option value="${row.id}" ${output === row.id ? 'selected' : ''} ${streaming && row.id !== 'email' ? 'disabled' : ''}>${escapeHtml(row.label)}</option>
  `).join('');
  const certOptions = [
    `<option value="" ${schedule.certificate_max ? '' : 'selected'}>Any (up to 18)</option>`,
    ...CERTIFICATES.filter((cert) => cert !== '18').map((cert) => `<option value="${cert}" ${schedule.certificate_max === cert ? 'selected' : ''}>Up to ${cert}</option>`),
  ].join('');
  const serviceNames = serviceLabels(services);
  const streamingHelp = serviceNames.length
    ? `Also suggest films on ${escapeHtml(serviceNames.join(', '))}. <a href="${SETTINGS}">Change services</a>. Turning this on means the schedule is emailed.`
    : `Pick your streaming services in <a href="${SETTINGS}">tool settings</a> first. Turning this on means the schedule is emailed.`;
  const action = schedule.id ? `${APP}?edit=${schedule.id}` : APP;

  return `${pageHeader(schedule.id ? 'Edit schedule' : 'New schedule', preset ? `Starting from the ${PRESETS[preset]?.name || preset} preset.` : 'Choose when it runs, what it picks, and where the films go.')}
    <form method="post" action="${action}" class="rec-form">
      <input type="hidden" name="action" value="save" />
      <input type="hidden" name="preset" value="${escapeHtml(schedule.preset || '')}" />

      <section class="panel settings-section">
        <h2 class="panel-title">Basics</h2>
        <div class="field">
          <label for="f-name">Name</label>
          <input id="f-name" name="name" type="text" required value="${escapeHtml(schedule.name || '')}" placeholder="Friday Film Night" />
          <p class="field-help">Also used as the Plex collection, playlist, or email title.</p>
        </div>
        <div style="margin-top:1rem">${toggle('enabled', Number(schedule.enabled) === 1, 'Enabled', 'Paused schedules keep their settings but do not run.')}</div>
      </section>

      <section class="panel settings-section">
        <h2 class="panel-title">When</h2>
        <div class="field">
          <label>Days</label>
          <div class="day-picks">${dayPicks}</div>
        </div>
        <div class="field">
          <label for="f-time">Time</label>
          <input id="f-time" type="time" name="time_local" value="${escapeHtml(schedule.time_local || '18:00')}" class="input-narrow" />
        </div>
      </section>

      <section class="panel settings-section">
        <h2 class="panel-title">What to pick</h2>
        <div class="field-grid">
          ${numberField('film_count', 'How many films', schedule.film_count || 1, 'min="1" max="10"')}
          <div class="field">
            <label for="f-cert">Age rating</label>
            <select id="f-cert" name="certificate_max">${certOptions}</select>
          </div>
        </div>
        <p class="field-help" style="margin-top:0.5rem">With an age rating set, films without a known UK certificate are skipped.</p>
        <div class="field-grid" style="margin-top:1rem">
          ${numberField('runtime_min', 'Shortest (minutes)', schedule.runtime_min, 'min="0"')}
          ${numberField('runtime_max', 'Longest (minutes)', schedule.runtime_max, 'min="0"')}
        </div>
        <div class="field-grid" style="margin-top:1rem">
          ${textField('genres', 'Only these genres', schedule.genres, 'Comedy, Drama')}
          ${textField('excluded_genres', 'Never these genres', schedule.excluded_genres, 'Horror')}
        </div>
        <div class="field-grid" style="margin-top:1rem">
          ${numberField('rating_min', 'Lowest TMDb score (0–10)', schedule.rating_min, 'min="0" max="10" step="0.1"')}
          ${numberField('rating_max', 'Highest TMDb score (0–10)', schedule.rating_max, 'min="0" max="10" step="0.1"')}
        </div>
        <div style="margin-top:1rem">${toggle('prefer_plex', schedule.prefer_plex == null || Number(schedule.prefer_plex) === 1, 'Prefer films already in Plex', 'Library films get a boost over streaming ones.')}</div>
      </section>

      <section class="panel settings-section">
        <h2 class="panel-title">Where it goes</h2>
        ${toggle('allow_streaming', streaming, 'Include streaming titles', streamingHelp)}
        <div class="field-grid" style="margin-top:1rem">
          <div class="field">
            <label for="f-output">Send to</label>
            <select id="f-output" name="output_type">${outputOptions}</select>
            <p class="field-help" id="output-help">${streaming ? 'Streaming titles can only be emailed.' : 'Collections and playlists only include films in your Plex library.'}</p>
          </div>
          <div class="field" id="library-field">
            <label for="f-library">Movie library</label>
            <select id="f-library" name="plex_section_id"><option value="">Choose a library</option>${libraryOptions}</select>
            <p class="field-help">Where the collection is created.</p>
          </div>
        </div>
        <div style="margin-top:1rem" id="replace-field">${toggle('replace_on_watch', schedule.replace_on_watch == null || Number(schedule.replace_on_watch) === 1, 'Replace a film after it is watched', 'Swaps in a fresh pick in the collection or playlist.')}</div>
      </section>

      <div class="row-actions">
        <button class="btn primary" type="submit">Save schedule</button>
        <a class="btn ghost" href="${APP}">Cancel</a>
      </div>
    </form>
    <script>
      (function () {
        var streaming = document.querySelector('input[name="allow_streaming"]');
        var output = document.getElementById('f-output');
        var help = document.getElementById('output-help');
        var library = document.getElementById('library-field');
        var replace = document.getElementById('replace-field');
        function sync() {
          var locked = streaming.checked;
          for (var i = 0; i < output.options.length; i++) {
            output.options[i].disabled = locked && output.options[i].value !== 'email';
          }
          if (locked) output.value = 'email';
          help.textContent = locked
            ? 'Streaming titles can only be emailed.'
            : 'Collections and playlists only include films in your Plex library.';
          library.style.display = output.value === 'collection' ? '' : 'none';
          replace.style.display = output.value === 'email' ? 'none' : '';
        }
        streaming.addEventListener('change', sync);
        output.addEventListener('change', sync);
        sync();
      })();
    </script>`;
}

export function renderTest({ schedule, picks, services, error }) {
  const output = effectiveOutput(schedule);
  const destination = output === 'email'
    ? 'be emailed'
    : `go into the Plex ${output === 'playlist' ? 'playlist' : 'collection'} “${schedule.name}”`;
  const serviceNames = serviceLabels(services);

  const rows = picks.map((pick, index) => `
    <div class="pick-row">
      <div class="pick-rank">${index + 1}</div>
      <div class="pick-body">
        <div class="pick-title">${escapeHtml(pick.title)}${pick.year ? ` <span class="muted">(${escapeHtml(pick.year)})</span>` : ''}</div>
        <div class="pick-meta">
          ${pick.certificate ? `<span class="cert cert-${escapeHtml(pick.certificate)}">${escapeHtml(pick.certificate)}</span>` : '<span class="cert">?</span>'}
          ${pick.runtimeMinutes ? `<span>${escapeHtml(pick.runtimeMinutes)} min</span>` : ''}
          ${(pick.genres || []).length ? `<span>${escapeHtml(pick.genres.slice(0, 3).join(', '))}</span>` : ''}
          ${pick.directors?.[0] ? `<span>${escapeHtml(pick.directors[0])}</span>` : ''}
        </div>
      </div>
      <span class="badge ${pick.inLibrary ? 'warn' : 'ok'} pick-where">${escapeHtml(whereToWatch(pick))}</span>
    </div>
  `).join('');

  const reasons = [
    schedule.certificate_max ? `The ${schedule.certificate_max} age cap skips films without a known UK certificate.` : null,
    schedule.genres ? `Only these genres: ${schedule.genres}.` : null,
    schedule.runtime_max || schedule.runtime_min ? 'The runtime limits may be too tight.' : null,
    Number(schedule.allow_streaming) && !serviceNames.length ? 'No streaming services are selected in tool settings.' : null,
    'Films recommended in the last 120 days are not repeated.',
  ].filter(Boolean);

  const body = error
    ? `<div class="flash flash-error">${escapeHtml(error)}</div>`
    : picks.length
      ? `<div class="pick-list">${rows}</div>`
      : `<div class="empty-state">
          <strong>No films matched</strong>
          <ul class="muted">${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>
        </div>`;

  return `${pageHeader(`Test: ${schedule.name}`, 'A dry run with the current settings. Nothing was published, emailed, or recorded.')}
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2 class="panel-title">${picks.length ? `${picks.length} film${picks.length === 1 ? '' : 's'} would ${destination}` : 'Result'}</h2>
          <p class="panel-hint">${escapeHtml(formatWhen(schedule))} · ${escapeHtml(capLabel(schedule.certificate_max))} · ${Number(schedule.allow_streaming) ? `Plex + ${escapeHtml(serviceNames.join(', ') || 'no services')}` : 'Plex only'}</p>
        </div>
      </div>
      ${body}
      <div class="row-actions">
        <a class="btn" href="${APP}?test=${schedule.id}">Test again</a>
        ${postButton({ action: 'run', id: schedule.id, label: 'Run for real', className: 'primary' })}
        <a class="btn ghost" href="${APP}?edit=${schedule.id}">Edit schedule</a>
        <a class="btn ghost" href="${APP}">Back</a>
      </div>
    </section>`;
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
    certificate_max: null,
    replace_on_watch: 1,
    remove_watchlist: 0,
    preset: presetKey || '',
  };
}
