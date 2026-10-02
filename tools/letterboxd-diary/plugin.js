import { planDiary, planUnmark, watchesFromExportZip } from './lib/diary.js';
import { buildIndex, loadMovies, movieSectionIds } from './lib/library.js';
import { diaryRssUrl, parseDiaryRss } from './lib/rss.js';
import { renderHome } from './lib/ui.js';

const APP = '/plugins/letterboxd-diary/app';
const HOUR_MS = 60 * 60 * 1000;
const SEEN_LIMIT = 1000;
const PREVIEW_LIST_LIMIT = 500;

let busy = false;

export async function activate(ctx) {
  const settings = ctx.settings.get();
  if (settings.catchUp && String(settings.letterboxdUsername || '').trim()) {
    void runScheduledCatchUp(ctx);
    const hours = Math.max(1, Number(settings.intervalHours) || 6);
    ctx.scheduler.every(hours * HOUR_MS, () => runScheduledCatchUp(ctx), 'letterboxd-diary-rss');
  }
  refreshPanel(ctx);
  ctx.log.info('Letterboxd Diary activated');
}

export async function deactivate(ctx) {
  ctx.log.info('Letterboxd Diary deactivated');
}

export async function handleRequest(ctx, req) {
  if (req.method === 'POST') return handlePost(ctx, req);
  const settings = ctx.settings.get();
  let libraryNames = [];
  if (ctx.plex.isConfigured()) {
    try {
      const selected = new Set((settings.libraries || []).map(String));
      const libraries = await ctx.plex.getLibraries();
      libraryNames = libraries
        .filter((lib) => lib.type === 'movie' && selected.has(String(lib.id)))
        .map((lib) => lib.title);
    } catch (err) {
      ctx.log.warn(`Could not list Plex libraries: ${err.message}`);
    }
  }
  return {
    title: 'Letterboxd Diary',
    body: renderHome({
      libraryNames,
      settings,
      pending: ctx.storage.get('pending'),
      lastCatchUp: ctx.storage.get('lastCatchUp'),
    }),
  };
}

async function handlePost(ctx, req) {
  const body = req.body || {};
  if (body.action === 'preview') {
    const encoded = String(body.zip_base64 || '');
    if (!encoded) throw new Error('Choose a Letterboxd export ZIP');
    const films = watchesFromExportZip(Buffer.from(encoded, 'base64'));
    const index = buildIndex(await loadSelectedMovies(ctx));
    const plan = planDiary(films, index);
    ctx.storage.set('pending', {
      createdAt: new Date().toISOString(),
      filmCount: films.length,
      toMark: plan.toMark,
      alreadyWatchedCount: plan.alreadyWatched.length,
      missing: plan.missing.slice(0, PREVIEW_LIST_LIMIT),
      missingCount: plan.missing.length,
      ambiguous: plan.ambiguous.slice(0, PREVIEW_LIST_LIMIT),
      ambiguousCount: plan.ambiguous.length,
    });
    return { redirect: APP, message: `Preview ready: ${plan.toMark.length} to mark watched` };
  }
  if (body.action === 'apply') {
    const pending = ctx.storage.get('pending');
    if (!pending) throw new Error('Nothing to apply. Upload the export ZIP again.');
    const outcome = await withLock(() => applyPending(ctx, pending));
    ctx.storage.delete('pending');
    refreshPanel(ctx);
    return outcome.error
      ? { redirect: APP, message: `Marked ${outcome.applied.length} before Plex failed: ${outcome.error.message}`, flash: 'error' }
      : { redirect: APP, message: `Marked ${outcome.applied.length} films watched${outcome.skipped ? ` (${outcome.skipped} already watched or gone)` : ''}` };
  }
  if (body.action === 'discard') {
    ctx.storage.delete('pending');
    return { redirect: APP, message: 'Preview discarded' };
  }
  throw new Error('Unknown action');
}

async function applyPending(ctx, pending) {
  const current = new Map(
    (await loadSelectedMovies(ctx)).map((item) => [String(item.ratingKey), item]),
  );
  const todo = pending.toMark.filter((change) => {
    const item = current.get(String(change.ratingKey));
    return item && !(Number(item.viewCount) > 0);
  });
  const outcome = await markAll(ctx, todo);
  recordMarks(ctx, outcome.applied, { title: 'Letterboxd diary import', source: 'zip' });
  return { ...outcome, skipped: pending.toMark.length - todo.length };
}

async function runScheduledCatchUp(ctx) {
  try {
    await withLock(() => runCatchUp(ctx));
  } catch (err) {
    ctx.log.error(`Letterboxd catch-up failed: ${err.message}`);
    saveCatchUp(ctx, `Failed: ${err.message}`);
  }
  refreshPanel(ctx);
}

async function runCatchUp(ctx) {
  const settings = ctx.settings.get();
  const res = await ctx.fetch(diaryRssUrl(settings.letterboxdUsername));
  const xml = await res.text();
  if (!res.ok) throw new Error(`Letterboxd RSS failed: HTTP ${res.status}`);

  const seen = ctx.storage.get('seenRss') || [];
  const seenSet = new Set(seen);
  const fresh = parseDiaryRss(xml).filter((entry) => !seenSet.has(entry.guid));
  if (!fresh.length) return saveCatchUp(ctx, 'No new diary entries');

  const index = buildIndex(await loadSelectedMovies(ctx));
  const plan = planDiary(fresh, index);
  const outcome = await markAll(ctx, plan.toMark);
  recordMarks(ctx, outcome.applied, { title: 'Letterboxd catch-up', source: 'rss' });
  if (outcome.error) throw outcome.error;

  ctx.storage.set('seenRss', [...seen, ...fresh.map((entry) => entry.guid)].slice(-SEEN_LIMIT));
  const message = `${fresh.length} new diary entries: ${outcome.applied.length} marked watched, ${plan.alreadyWatched.length} already watched, ${plan.missing.length} not in your libraries, ${plan.ambiguous.length} ambiguous`;
  ctx.log.info(message);
  return saveCatchUp(ctx, message);
}

async function loadSelectedMovies(ctx) {
  const sections = await movieSectionIds(ctx.plex, ctx.settings.get().libraries);
  if (!sections.length) throw new Error('Choose at least one movie library in tool settings first.');
  return loadMovies(ctx.plex, sections);
}

async function markAll(ctx, changes) {
  const applied = [];
  for (const change of changes) {
    try {
      await ctx.plex.markWatched(change.ratingKey);
    } catch (error) {
      return { applied, error };
    }
    applied.push(change);
  }
  return { applied, error: null };
}

function recordMarks(ctx, applied, { title, source }) {
  if (!applied.length) return;
  ctx.changes.recordBatch({
    title,
    summary: applied.map((c) => `${c.title}${c.year ? ` (${c.year})` : ''}: Unwatched -> Watched`).join('\n'),
    changes: applied,
    meta: { source },
  });
  ctx.log.info(`${title}: marked ${applied.length} films watched`);
}

function saveCatchUp(ctx, message) {
  ctx.storage.set('lastCatchUp', { at: new Date().toISOString(), message });
}

async function withLock(fn) {
  if (busy) throw new Error('Another diary run is in progress. Try again in a moment.');
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

function refreshPanel(ctx) {
  const settings = ctx.settings.get();
  const last = ctx.storage.get('lastCatchUp');
  const items = [];
  if (settings.catchUp) {
    items.push({
      id: 'catch-up',
      title: `RSS catch-up for @${settings.letterboxdUsername || '?'}`,
      subtitle: last?.message || 'Not checked yet',
      meta: last?.at ? `Last check: ${last.at}` : '',
      actions: [{ id: 'checkNow', label: 'Check now' }],
    });
  }
  for (const batch of ctx.changes.list({ limit: 15 }).filter((b) => !b.undone)) {
    const count = (batch.payload?.changes || []).length;
    items.push({
      id: String(batch.id),
      title: batch.title,
      subtitle: `${count} film${count === 1 ? '' : 's'} marked watched`,
      meta: batch.created_at,
      actions: [
        { id: 'undo', label: 'Undo', confirm: 'Mark these films unwatched again?' },
        {
          id: 'forceUndo',
          label: 'Force undo',
          confirm: 'Force undo also unmarks films you have played since. Continue?',
        },
      ],
    });
  }
  ctx.panels.add({
    title: 'Letterboxd Diary',
    empty: 'Nothing marked yet. Open the tool to import your Letterboxd export.',
    items,
    actions: {
      async checkNow() {
        await withLock(() => runCatchUp(ctx));
        refreshPanel(ctx);
        return { message: ctx.storage.get('lastCatchUp')?.message || 'Checked' };
      },
      async undo({ body, force }) {
        return withLock(() => undoBatch(ctx, Number(body.itemId), { force: Boolean(force) }));
      },
      async forceUndo({ body }) {
        return withLock(() => undoBatch(ctx, Number(body.itemId), { force: true }));
      },
    },
  });
}

async function undoBatch(ctx, batchId, { force = false } = {}) {
  const batch = ctx.changes.get(batchId);
  if (!batch) throw new Error('Change not found');
  if (batch.undone) throw new Error('Already undone');

  const changes = batch.payload?.changes || [];
  const states = new Map();
  for (const change of changes) {
    states.set(String(change.ratingKey), await ctx.plex.getWatchState(change.ratingKey));
  }
  const plan = planUnmark(changes, states, { force });
  if (plan.conflicts.length) {
    const names = plan.conflicts.slice(0, 5).map((c) => c.title).join(', ');
    return {
      warning: `${plan.conflicts.length} films were played after they were marked (${names}${plan.conflicts.length > 5 ? ', …' : ''}). Nothing was changed. Use Force undo to unmark them anyway.`,
    };
  }
  for (const change of plan.apply) {
    await ctx.plex.markUnwatched(change.ratingKey);
  }
  ctx.changes.markUndone(batchId);
  ctx.log.info(`Undo diary batch #${batchId}: ${plan.apply.length} unmarked, ${plan.skipped.length} skipped`);
  refreshPanel(ctx);
  return { message: `Undo complete (${plan.apply.length} films marked unwatched)` };
}

export const _internal = { applyPending, runCatchUp, undoBatch };
