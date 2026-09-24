import { SCHEDULE_PRIORITY_HELP } from './schedule.js';
import { isBrowserPreviewable } from './media.js';

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

export function prerollTabs(active, basePath) {
  const tabs = [
    { id: 'overview', href: `${basePath}?tab=overview`, label: 'Overview' },
    { id: 'buckets', href: `${basePath}?tab=buckets`, label: 'Buckets' },
    { id: 'schedules', href: `${basePath}?tab=schedules`, label: 'Schedules' },
  ];
  return `<div class="tabs">${tabs
    .map(
      (t) =>
        `<a class="${active === t.id ? 'active' : ''}" href="${t.href}">${escapeHtml(t.label)}</a>`,
    )
    .join('')}</div>`;
}

function formatDuration(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return '—';
  const total = Math.round(Number(ms) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatWhen(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(d.getTime())) return escapeHtml(iso);
    return escapeHtml(
      d.toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    );
  } catch {
    return escapeHtml(iso);
  }
}

function formatMonthDay(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return dateStr;
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const month = months[Number(m[2]) - 1] || m[2];
  return `${Number(m[3])} ${month}`;
}

function dateRangeLabel(schedule) {
  if (!schedule.start_date && !schedule.end_date) return 'Always active (default)';
  const yearly =
    schedule.repeat_yearly === 1 || schedule.repeat_yearly === true;
  const parts = [];
  if (schedule.start_date) {
    parts.push(yearly ? formatMonthDay(schedule.start_date) : schedule.start_date);
  }
  if (schedule.end_date) {
    parts.push(yearly ? formatMonthDay(schedule.end_date) : schedule.end_date);
  }
  const range = parts.join(' → ');
  return yearly ? `${range} (every year)` : range;
}

export function renderOverview({
  buckets,
  schedules,
  activeSchedule,
  state,
  steps,
  basePath,
}) {
  const hasBuckets = (buckets || []).length > 0;
  const hasSchedules = (schedules || []).length > 0;

  if (!hasBuckets || !hasSchedules) {
    return `${pageHeader('Preroll', 'Simple cinema idents and trailers for Plex.')}
      ${prerollTabs('overview', basePath)}
      <section class="panel">
        <h2 class="panel-title">Set up your first preroll</h2>
        <p>Create a media bucket, add some videos, then create a schedule.</p>
        <p class="muted">Example:</p>
        <pre class="listing-empty" style="white-space:pre-wrap;margin:0.75rem 0">Cinema Idents → 1 random
Trailers &amp; Adverts → 1 random</pre>
        <div class="row-actions">
          <a class="btn primary" href="${basePath}?tab=buckets&amp;new=1">Create Bucket</a>
          ${hasBuckets ? `<a class="btn" href="${basePath}?tab=schedules&amp;new=1">Create Schedule</a>` : `<span class="muted">Add Videos → Create Schedule → Activate</span>`}
        </div>
        <p class="panel-hint" style="margin-top:1rem">Guided path: <strong>Create Bucket → Add Videos → Create Schedule → Activate</strong></p>
      </section>`;
  }

  const items = state?.items || [];
  const nextList =
    items.length > 0
      ? `<ul class="list-stack">${items
          .map(
            (it) =>
              `<li class="list-row"><div><strong>${escapeHtml(it.filename)}</strong><div class="muted">${escapeHtml(it.bucketName || '')}</div></div></li>`,
          )
          .join('')}</ul>`
      : `<p class="muted">No preroll generated yet.</p>`;

  const sequence =
    (steps || []).length > 0
      ? `<ol class="list-stack">${steps
          .map(
            (s, i) =>
              `<li class="list-row"><div><strong>${i + 1}. ${escapeHtml(s.bucket_name || `Bucket #${s.bucket_id}`)}</strong><div class="muted">${escapeHtml(String(s.count))} random</div></div></li>`,
          )
          .join('')}</ol>`
      : `<p class="muted">No steps on the active schedule.</p>`;

  const warning = state?.warning
    ? `<div class="flash flash-error" style="margin-bottom:1rem">${escapeHtml(state.warning)}</div>`
    : '';

  const previewBlock =
    items.length > 0
      ? `<section class="panel" id="preview">
        <h2 class="panel-title">Preview</h2>
        <p class="panel-hint">Local files only — this does not recreate Plex playback.</p>
        ${items
          .map((it) => {
            if (it.previewable || isBrowserPreviewable(it.filename)) {
              return `<div style="margin-bottom:1rem">
                <div class="muted" style="margin-bottom:0.35rem">${escapeHtml(it.filename)}</div>
                <video controls preload="metadata" style="max-width:100%;border-radius:8px;background:#000" src="${basePath}?media=${encodeURIComponent(it.id)}"></video>
              </div>`;
            }
            return `<div class="list-row"><div><strong>${escapeHtml(it.filename)}</strong><div class="muted">Preview unavailable in browser (still used by Plex)</div></div></div>`;
          })
          .join('')}
      </section>`
      : '';

  return `${pageHeader('Preroll', 'Buckets → Schedules → Next preroll')}
    ${prerollTabs('overview', basePath)}
    ${warning}
    <div class="stat-grid">
      <div class="stat-card">
        <div class="label">Active schedule</div>
        <div class="value">${escapeHtml(activeSchedule?.name || 'None')}</div>
        <div class="hint">${activeSchedule ? escapeHtml(dateRangeLabel(activeSchedule)) : 'Create or enable a schedule'}</div>
      </div>
      <div class="stat-card">
        <div class="label">Last updated</div>
        <div class="value" style="font-size:1.1rem">${formatWhen(state?.generated_at)}</div>
        <div class="hint">${escapeHtml(activeSchedule?.selection_mode === 'random_avoid_repeats' ? 'Random, avoid repeats' : 'Random')}</div>
      </div>
    </div>
    <div class="field-grid" style="align-items:start">
      <section class="panel">
        <h2 class="panel-title">Next preroll</h2>
        ${nextList}
        <div class="row-actions" style="margin-top:1rem">
          <a class="btn" href="${basePath}?tab=overview#preview">Preview</a>
          <form method="post" action="${basePath}" style="display:inline">
            <input type="hidden" name="action" value="roll" />
            <button class="primary" type="submit">Roll Again</button>
          </form>
        </div>
      </section>
      <section class="panel">
        <h2 class="panel-title">Sequence</h2>
        ${sequence}
      </section>
    </div>
    ${previewBlock}
    <p class="muted" style="margin-top:1rem">Plex plays this sequence when Cinema Trailers are enabled on the client and the movie library. Paths must be readable by the Plex Media Server process. Path mapping lives in this tool’s Settings.</p>`;
}

function formatBucketScanError(raw) {
  if (!raw) return null;
  try {
    const err = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!err?.message) return null;
    const code = err.code ? ` (${err.code})` : '';
    const at = err.path ? ` — ${err.path}` : '';
    return `${err.message}${code}${at}`;
  } catch {
    return String(raw);
  }
}

export function renderBuckets({
  buckets,
  editing,
  items,
  showNew,
  openBucket,
  openItems,
  basePath,
}) {
  const formBucket = editing || (showNew ? {} : null);
  const form = formBucket
    ? bucketForm(formBucket, basePath)
    : `<div class="row-actions"><a class="btn primary" href="${basePath}?tab=buckets&amp;new=1">Add bucket</a></div>`;

  const list =
    (buckets || []).length === 0
      ? `<p class="muted">No buckets yet. Add a folder of idents or trailers.</p>`
      : `<ul class="list-stack">${buckets
          .map((b) => {
            const badge = b.enabled
              ? `<span class="badge ok">On</span>`
              : `<span class="badge">Off</span>`;
            const scanErr = formatBucketScanError(b.scan_error);
            const scanErrBlock = scanErr
              ? `<div class="flash flash-error" style="margin-top:0.35rem;padding:0.35rem 0.5rem">${escapeHtml(scanErr)}</div>`
              : '';
            return `<li class="list-row">
              <div>
                <strong>${escapeHtml(b.name)}</strong> ${badge}
                <div class="muted">${escapeHtml(b.folder_path)}</div>
                <div class="muted">${Number(b.video_count) || 0} videos${b.description ? ` · ${escapeHtml(b.description)}` : ''}</div>
                ${scanErrBlock}
              </div>
              <div class="row-actions">
                <a class="btn ghost" href="${basePath}?tab=buckets&amp;bucket=${b.id}">Open</a>
                <a class="btn ghost" href="${basePath}?tab=buckets&amp;edit=${b.id}">Edit</a>
                <form method="post" action="${basePath}" onsubmit="return confirm('Delete this bucket?')">
                  <input type="hidden" name="action" value="bucket_delete" />
                  <input type="hidden" name="id" value="${b.id}" />
                  <button class="danger" type="submit">Delete</button>
                </form>
              </div>
            </li>`;
          })
          .join('')}</ul>`;

  const detail =
    openBucket && openItems
      ? renderBucketItems(openBucket, openItems, basePath)
      : editing && items
        ? renderBucketItems(editing, items, basePath)
        : '';

  return `${pageHeader('Preroll', 'Named folders of video files')}
    ${prerollTabs('buckets', basePath)}
    <section class="panel">
      <h2 class="panel-title">${editing?.id ? 'Edit bucket' : showNew ? 'New bucket' : 'Buckets'}</h2>
      ${form}
    </section>
    <section class="panel">
      <h2 class="panel-title">Your buckets</h2>
      ${list}
    </section>
    ${detail}`;
}

function bucketForm(bucket, basePath) {
  const isEdit = Boolean(bucket.id);
  return `<form method="post" action="${basePath}">
    <input type="hidden" name="action" value="${isEdit ? 'bucket_update' : 'bucket_create'}" />
    ${isEdit ? `<input type="hidden" name="id" value="${bucket.id}" />` : ''}
    <div class="field-grid">
      <div class="field">
        <label for="name">Name</label>
        <input id="name" name="name" required value="${escapeHtml(bucket.name || '')}" placeholder="Cinema Idents" />
      </div>
      <div class="field">
        <label for="folder_path">Folder path</label>
        <input id="folder_path" name="folder_path" required value="${escapeHtml(bucket.folder_path || '')}" placeholder="/prerolls/idents" />
        <p class="field-help">Path visible inside Plex Toolkit (mount the folder in Docker if needed).</p>
      </div>
    </div>
    <div class="field">
      <label for="description">Description (optional)</label>
      <input id="description" name="description" value="${escapeHtml(bucket.description || '')}" />
    </div>
    <div class="toggle-row">
      <div class="toggle-copy"><strong>Enabled</strong></div>
      <input type="checkbox" name="enabled" value="1" ${bucket.enabled === 0 || bucket.enabled === false ? '' : 'checked'} />
    </div>
    <div class="row-actions">
      <button class="primary" type="submit">${isEdit ? 'Save' : 'Create bucket'}</button>
      <a class="btn ghost" href="${basePath}?tab=buckets">Cancel</a>
    </div>
  </form>`;
}

export function renderBucketItems(bucket, items, basePath) {
  const scanErr = formatBucketScanError(bucket.scan_error);
  const scanErrBlock = scanErr
    ? `<div class="flash flash-error" style="margin-bottom:0.75rem">${escapeHtml(scanErr)}</div>`
    : '';
  const rows =
    (items || []).length === 0
      ? `<p class="muted">No videos found. Check the folder path and click Rescan.</p>`
      : `<ul class="list-stack">${items
          .map((it) => {
            const missing = it.missing
              ? `<span class="badge err">Missing</span>`
              : '';
            const on = it.enabled
              ? `<span class="badge ok">On</span>`
              : `<span class="badge">Off</span>`;
            const play =
              !it.missing && isBrowserPreviewable(it.filename)
                ? `<a class="btn ghost" href="${basePath}?media=${it.id}" target="_blank" rel="noopener">Play</a>`
                : '';
            return `<li class="list-row">
              <div>
                <strong>${escapeHtml(it.filename)}</strong> ${on} ${missing}
                <div class="muted">Duration ${formatDuration(it.duration_ms)}</div>
              </div>
              <div class="row-actions">
                ${play}
                <form method="post" action="${basePath}">
                  <input type="hidden" name="action" value="item_toggle" />
                  <input type="hidden" name="id" value="${it.id}" />
                  <input type="hidden" name="enabled" value="${it.enabled ? '0' : '1'}" />
                  <button class="ghost" type="submit">${it.enabled ? 'Disable' : 'Enable'}</button>
                </form>
              </div>
            </li>`;
          })
          .join('')}</ul>`;

  return `<section class="panel">
    <h2 class="panel-title">${escapeHtml(bucket.name)} — videos</h2>
    <div class="row-actions" style="margin-bottom:0.75rem">
      <form method="post" action="${basePath}">
        <input type="hidden" name="action" value="bucket_rescan" />
        <input type="hidden" name="id" value="${bucket.id}" />
        <button type="submit">Rescan folder</button>
      </form>
    </div>
    ${scanErrBlock}
    ${rows}
  </section>`;
}

export function renderSchedules({
  schedules,
  buckets,
  editing,
  steps,
  showNew,
  pathPrefixes,
  basePath,
}) {
  const formSchedule =
    editing || (showNew ? { enabled: 1, selection_mode: 'random' } : null);
  const form = formSchedule
    ? scheduleForm(formSchedule, buckets, steps || [], basePath)
    : `<div class="row-actions"><a class="btn primary" href="${basePath}?tab=schedules&amp;new=1">Add schedule</a></div>`;

  const list =
    (schedules || []).length === 0
      ? `<p class="muted">No schedules yet.</p>`
      : `<ul class="list-stack">${schedules
          .map((s) => {
            const badge = s.enabled
              ? `<span class="badge ok">On</span>`
              : `<span class="badge">Off</span>`;
            return `<li class="list-row">
              <div>
                <strong>${escapeHtml(s.name)}</strong> ${badge}
                <div class="muted">${escapeHtml(dateRangeLabel(s))}${s.start_time || s.end_time ? ` · ${escapeHtml(s.start_time || '…')}–${escapeHtml(s.end_time || '…')}` : ''}</div>
                <div class="muted">${s.selection_mode === 'random_avoid_repeats' ? 'Random, avoid repeats' : 'Random'}</div>
              </div>
              <div class="row-actions">
                <a class="btn ghost" href="${basePath}?tab=schedules&amp;edit=${s.id}">Edit</a>
                <form method="post" action="${basePath}" onsubmit="return confirm('Delete this schedule?')">
                  <input type="hidden" name="action" value="schedule_delete" />
                  <input type="hidden" name="id" value="${s.id}" />
                  <button class="danger" type="submit">Delete</button>
                </form>
              </div>
            </li>`;
          })
          .join('')}</ul>`;

  const prefixHint =
    pathPrefixes?.toolkitPrefix || pathPrefixes?.plexPrefix
      ? `<p class="muted">Path mapping: ${escapeHtml(pathPrefixes.toolkitPrefix || '(none)')} → ${escapeHtml(pathPrefixes.plexPrefix || '(none)')}. Change under tool Settings.</p>`
      : `<p class="muted">Optional Toolkit↔Plex path mapping is under this tool’s Settings page.</p>`;

  return `${pageHeader('Preroll', 'When to use which buckets')}
    ${prerollTabs('schedules', basePath)}
    <section class="panel">
      <h2 class="panel-title">${editing?.id ? 'Edit schedule' : showNew ? 'New schedule' : 'Schedules'}</h2>
      <p class="panel-hint">${escapeHtml(SCHEDULE_PRIORITY_HELP)}</p>
      ${form}
    </section>
    <section class="panel">
      <h2 class="panel-title">Your schedules</h2>
      ${list}
      ${prefixHint}
    </section>`;
}

function scheduleForm(schedule, buckets, steps, basePath) {
  const isEdit = Boolean(schedule.id);
  const stepRows = (steps.length ? steps : [{ bucket_id: buckets[0]?.id, count: 1 }])
    .map(
      (st) => `
      <div class="field-grid preroll-step">
        <div class="field">
          <label>Bucket</label>
          <select name="step_bucket">${bucketOptions(buckets, st.bucket_id || st.bucketId)}</select>
        </div>
        <div class="field">
          <label>Count</label>
          <input type="number" name="step_count" min="1" max="20" value="${escapeHtml(String(st.count || 1))}" />
        </div>
        <div class="field" style="align-self:end">
          <div class="row-actions">
            <button type="button" class="ghost move-up" title="Move up">↑</button>
            <button type="button" class="ghost move-down" title="Move down">↓</button>
            <button type="button" class="danger remove-step">Remove</button>
          </div>
        </div>
      </div>`,
    )
    .join('');

  return `<form method="post" action="${basePath}" id="schedule-form">
    <input type="hidden" name="action" value="${isEdit ? 'schedule_update' : 'schedule_create'}" />
    ${isEdit ? `<input type="hidden" name="id" value="${schedule.id}" />` : ''}
    <div class="field-grid">
      <div class="field">
        <label for="name">Name</label>
        <input id="name" name="name" required value="${escapeHtml(schedule.name || '')}" placeholder="Halloween" />
      </div>
      <div class="field">
        <label for="selection_mode">Selection</label>
        <select id="selection_mode" name="selection_mode">
          <option value="random" ${schedule.selection_mode !== 'random_avoid_repeats' ? 'selected' : ''}>Random</option>
          <option value="random_avoid_repeats" ${schedule.selection_mode === 'random_avoid_repeats' ? 'selected' : ''}>Random, avoid repeats</option>
        </select>
      </div>
    </div>
    <div class="field-grid">
      <div class="field">
        <label for="start_date">Start date</label>
        <input id="start_date" type="date" name="start_date" value="${escapeHtml(schedule.start_date || '')}" />
      </div>
      <div class="field">
        <label for="end_date">End date</label>
        <input id="end_date" type="date" name="end_date" value="${escapeHtml(schedule.end_date || '')}" />
      </div>
    </div>
    <div class="field-grid">
      <div class="field">
        <label for="start_time">Start time (optional)</label>
        <input id="start_time" type="time" name="start_time" value="${escapeHtml(schedule.start_time || '')}" />
      </div>
      <div class="field">
        <label for="end_time">End time (optional)</label>
        <input id="end_time" type="time" name="end_time" value="${escapeHtml(schedule.end_time || '')}" />
      </div>
    </div>
    <p class="field-help">Leave dates empty for the default always-on schedule. Times do not wrap overnight. Use Repeat every year for Halloween/Christmas (month and day apply every year; ranges may wrap New Year).</p>
    <div class="toggle-row">
      <div class="toggle-copy">
        <strong>Repeat every year</strong>
        <span>Ignore the year — match this month/day range annually</span>
      </div>
      <input type="checkbox" name="repeat_yearly" value="1" ${schedule.repeat_yearly === 1 || schedule.repeat_yearly === true ? 'checked' : ''} />
    </div>
    <div class="toggle-row">
      <div class="toggle-copy"><strong>Enabled</strong></div>
      <input type="checkbox" name="enabled" value="1" ${schedule.enabled === 0 || schedule.enabled === false ? '' : 'checked'} />
    </div>
    <h3 class="panel-title" style="margin-top:1rem">Sequence</h3>
    <p class="panel-hint">Ordered bucket steps. The same bucket can appear more than once.</p>
    <div id="steps">${stepRows}</div>
    <div class="row-actions" style="margin:0.75rem 0">
      <button type="button" class="ghost" id="add-step">Add step</button>
    </div>
    <div class="row-actions">
      <button class="primary" type="submit">${isEdit ? 'Save schedule' : 'Create schedule'}</button>
      <a class="btn ghost" href="${basePath}?tab=schedules">Cancel</a>
    </div>
  </form>
  <template id="step-template">
    <div class="field-grid preroll-step">
      <div class="field">
        <label>Bucket</label>
        <select name="step_bucket">${bucketOptions(buckets, null)}</select>
      </div>
      <div class="field">
        <label>Count</label>
        <input type="number" name="step_count" min="1" max="20" value="1" />
      </div>
      <div class="field" style="align-self:end">
        <div class="row-actions">
          <button type="button" class="ghost move-up" title="Move up">↑</button>
          <button type="button" class="ghost move-down" title="Move down">↓</button>
          <button type="button" class="danger remove-step">Remove</button>
        </div>
      </div>
    </div>
  </template>
  <script>
    (function () {
      var add = document.getElementById('add-step');
      var steps = document.getElementById('steps');
      var tpl = document.getElementById('step-template');
      if (!add || !steps || !tpl) return;
      add.addEventListener('click', function () {
        steps.appendChild(tpl.content.cloneNode(true));
      });
      steps.addEventListener('click', function (e) {
        var t = e.target;
        if (!t) return;
        var row = t.closest('.preroll-step');
        if (!row) return;
        if (t.classList.contains('remove-step')) {
          if (steps.querySelectorAll('.preroll-step').length > 1) row.remove();
          return;
        }
        if (t.classList.contains('move-up')) {
          if (row.previousElementSibling) steps.insertBefore(row, row.previousElementSibling);
          return;
        }
        if (t.classList.contains('move-down') && row.nextElementSibling) {
          steps.insertBefore(row.nextElementSibling, row);
        }
      });
    })();
  </script>`;
}

function bucketOptions(buckets, selectedId) {
  if (!buckets?.length) return `<option value="">No buckets</option>`;
  return buckets
    .map(
      (b) =>
        `<option value="${b.id}" ${String(b.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(b.name)}</option>`,
    )
    .join('');
}

export function parseStepsFromBody(body) {
  let buckets = body.step_bucket;
  let counts = body.step_count;
  if (buckets == null) return [];
  if (!Array.isArray(buckets)) buckets = [buckets];
  if (!Array.isArray(counts)) counts = [counts];
  const steps = [];
  for (let i = 0; i < buckets.length; i++) {
    const bucketId = Number(buckets[i]);
    if (!bucketId) continue;
    steps.push({
      bucketId,
      count: Math.max(1, Number(counts[i]) || 1),
    });
  }
  return steps;
}
