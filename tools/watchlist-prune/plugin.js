import { loadMovies, movieSectionIds } from './lib/library.js';
import { planAgeRemovals, planWatchedRemovals, updateFirstSeen } from './lib/prune.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let busy = false;

export async function activate(ctx) {
  const settings = ctx.settings.get();
  if (settings.enabled !== false) {
    ctx.events.on('movie.watched', (payload) => {
      onMovieWatched(ctx, payload).catch((err) => {
        ctx.log.error(`Watchlist prune after watch failed: ${err.message}`);
      });
    });
    void runScheduledSweep(ctx);
    ctx.scheduler.every(DAY_MS, () => runScheduledSweep(ctx), 'watchlist-prune-sweep');
  }
  refreshPanel(ctx);
  ctx.log.info('Watchlist Prune activated');
}

export async function deactivate(ctx) {
  ctx.log.info('Watchlist Prune deactivated');
}

async function onMovieWatched(ctx, payload) {
  if (!payload?.ratingKey) return;
  const sections = await movieSectionIds(ctx.plex, ctx.settings.get().libraries);
  if (!payload.librarySectionID || !sections.includes(String(payload.librarySectionID))) return;
  if (busy) return;

  await withLock(async () => {
    const meta = await ctx.plex.getMetadata(payload.ratingKey);
    if (!meta) return;
    const watchlist = await ctx.plex.getWatchlist();
    const plan = planWatchedRemovals(
      watchlist,
      [{ ...meta, viewCount: Math.max(1, Number(meta.viewCount) || 0) }],
      keptKeys(ctx),
    );
    const removed = await removeAll(ctx, plan.removals);
    if (removed.length) refreshPanel(ctx);
  });
}

async function runScheduledSweep(ctx) {
  try {
    await withLock(() => sweep(ctx));
  } catch (err) {
    ctx.log.error(`Watchlist sweep failed: ${err.message}`);
    saveStatus(ctx, `Failed: ${err.message}`);
  }
  refreshPanel(ctx);
}

async function sweep(ctx) {
  const settings = ctx.settings.get();
  const now = new Date();
  const kept = keptKeys(ctx);
  const watchlist = await ctx.plex.getWatchlist();
  const firstSeen = updateFirstSeen(ctx.storage.get('firstSeen') || {}, watchlist, now.toISOString());
  ctx.storage.set('firstSeen', firstSeen);

  const parts = [];
  const removedKeys = new Set();
  const sections = await movieSectionIds(ctx.plex, settings.libraries);
  if (sections.length) {
    const watched = (await loadMovies(ctx.plex, sections)).filter((item) => Number(item.viewCount) > 0);
    const plan = planWatchedRemovals(watchlist, watched, kept);
    const removed = await removeAll(ctx, plan.removals);
    for (const r of removed) removedKeys.add(String(r.entry.ratingKey));
    parts.push(`${removed.length} watched removed`);
    if (plan.ambiguous.length) parts.push(`${plan.ambiguous.length} ambiguous skipped`);
  } else {
    parts.push('no movie libraries selected');
  }

  const maxAgeDays = Number(settings.maxAgeDays) || 0;
  if (maxAgeDays > 0) {
    const remaining = watchlist.filter((entry) => !removedKeys.has(String(entry.ratingKey)));
    const removed = await removeAll(ctx, planAgeRemovals(remaining, firstSeen, now.getTime(), maxAgeDays, kept));
    parts.push(`${removed.length} older than ${maxAgeDays} days removed`);
  }

  const message = `Watchlist sweep: ${parts.join(', ')}`;
  ctx.log.info(message);
  saveStatus(ctx, message);
}

async function removeAll(ctx, removals) {
  const done = [];
  for (const removal of removals) {
    const { entry } = removal;
    await ctx.plex.removeFromWatchlist(entry.ratingKey);
    const why = removal.reason === 'age'
      ? `On the watchlist for ${removal.ageDays} days`
      : 'Watched in Plex';
    ctx.changes.recordBatch({
      title: `${entry.title || 'Film'}${entry.year ? ` (${entry.year})` : ''}`,
      summary: `Removed from watchlist: ${why}`,
      changes: [{ ratingKey: String(entry.ratingKey), title: entry.title || '', year: entry.year ?? null }],
      meta: { reason: removal.reason, why, libraryRatingKey: removal.libraryRatingKey || null },
    });
    ctx.log.info(`Removed ${entry.title} from the watchlist (${why})`);
    done.push(removal);
  }
  return done;
}

function keptKeys(ctx) {
  return new Set((ctx.storage.get('kept') || []).map(String));
}

function saveStatus(ctx, message) {
  ctx.storage.set('lastSweep', { at: new Date().toISOString(), message });
}

async function withLock(fn) {
  if (busy) throw new Error('Another watchlist prune is in progress. Try again in a moment.');
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

function refreshPanel(ctx) {
  const last = ctx.storage.get('lastSweep');
  const items = [
    {
      id: 'sweep',
      title: 'Daily sweep',
      subtitle: last?.message || 'Not run yet',
      meta: last?.at ? `Last run: ${last.at}` : '',
      actions: [{ id: 'sweepNow', label: 'Sweep now' }],
    },
  ];
  for (const batch of ctx.changes.list({ limit: 15 }).filter((b) => !b.undone)) {
    items.push({
      id: String(batch.id),
      title: batch.title,
      subtitle: batch.payload?.meta?.why || 'Removed from watchlist',
      meta: batch.created_at,
      actions: [
        {
          id: 'putBack',
          label: 'Put back',
          confirm: 'Put this film back on your watchlist? It will not be pruned again.',
        },
      ],
    });
  }
  ctx.panels.add({
    title: 'Watchlist Prune',
    empty: 'Nothing removed yet',
    items,
    actions: {
      async sweepNow() {
        await withLock(() => sweep(ctx));
        refreshPanel(ctx);
        return { message: ctx.storage.get('lastSweep')?.message || 'Sweep finished' };
      },
      async putBack({ body }) {
        return withLock(() => putBack(ctx, Number(body.itemId)));
      },
    },
  });
}

async function putBack(ctx, batchId) {
  const batch = ctx.changes.get(batchId);
  if (!batch) throw new Error('Removal not found');
  if (batch.undone) throw new Error('Already put back');
  const changes = batch.payload?.changes || [];
  for (const change of changes) {
    await ctx.plex.addToWatchlist(change.ratingKey);
  }
  const kept = keptKeys(ctx);
  for (const change of changes) kept.add(String(change.ratingKey));
  ctx.storage.set('kept', [...kept]);
  ctx.changes.markUndone(batchId);
  refreshPanel(ctx);
  return { message: `Put ${batch.title} back on your watchlist` };
}

export const _internal = { onMovieWatched, sweep, putBack };
