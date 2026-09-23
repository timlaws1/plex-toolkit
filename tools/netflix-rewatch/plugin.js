import {
  planRewind,
  planUndo,
  formatEpisodeCode,
  isShowAllowed,
} from './rewind.js';

const processedSessions = new Set();
const showLocks = new Map();

/** @type {any} */
let ctxRef = null;

export async function activate(ctx) {
  ctxRef = ctx;
  ctx.log.info('Netflix Rewatch activated');

  ctx.events.on('playback.progress', (payload) => onPlayback(ctx, payload));
  ctx.events.on('playback.finished', (payload) => onPlayback(ctx, payload));

  refreshPanel(ctx);
}

export async function deactivate(ctx) {
  ctx.log.info('Netflix Rewatch deactivated');
  processedSessions.clear();
  showLocks.clear();
  ctxRef = null;
}

async function onPlayback(ctx, payload) {
  const settings = ctx.settings.get();
  if (settings.enabled === false) return;
  if (payload?.type && payload.type !== 'episode') return;
  if (payload.wasWatchedAtStart !== true) return;

  const threshold = Number(settings.watchedThreshold ?? 90);
  if (!(payload.progressPercent >= threshold)) return;

  const sessionId = `${payload.accountId}:${payload.sessionKey || payload.ratingKey}`;
  if (processedSessions.has(sessionId)) return;

  const libraries = (settings.libraries || []).map(String);
  if (libraries.length === 0) return;
  if (
    payload.librarySectionID &&
    !libraries.includes(String(payload.librarySectionID))
  ) {
    return;
  }

  const showTitle = payload.grandparentTitle || '';
  if (!isShowAllowed(showTitle, settings)) return;

  const showKey = payload.grandparentRatingKey;
  if (!showKey) {
    ctx.log.warn('Rewatch skipped: missing show rating key');
    return;
  }

  if (showLocks.get(showKey)) return;
  showLocks.set(showKey, true);
  processedSessions.add(sessionId);

  try {
    await runRewind(ctx, payload, settings);
  } catch (err) {
    processedSessions.delete(sessionId);
    ctx.log.error(`Rewind failed: ${err.message}`);
  } finally {
    showLocks.delete(showKey);
  }
}

async function runRewind(ctx, payload, settings) {
  const episodes = await ctx.plex.getEpisodes(payload.grandparentRatingKey);
  if (!episodes?.length) {
    ctx.log.warn('Rewind aborted: could not load episodes');
    return;
  }

  // Fail closed if we cannot confirm states (empty means API returned nothing)
  const plan = planRewind(
    episodes,
    {
      ratingKey: payload.ratingKey,
      parentIndex: payload.parentIndex,
      index: payload.index,
    },
    { includeSpecials: Boolean(settings.includeSpecials) },
  );

  if (plan.error) {
    ctx.log.warn(plan.error);
    return;
  }

  if (plan.changes.length === 0) {
    ctx.log.info(
      `No watch-state changes needed for ${payload.grandparentTitle} ${formatEpisodeCode(payload.parentIndex, payload.index)}`,
    );
    return;
  }

  const dryRun = Boolean(settings.dryRun);
  const applied = [];

  for (const change of plan.changes) {
    if (!dryRun) {
      if (change.to === 'watched') {
        await ctx.plex.markWatched(change.ratingKey);
      } else {
        await ctx.plex.markUnwatched(change.ratingKey);
      }
    }
    applied.push(change);
  }

  const replayed = formatEpisodeCode(payload.parentIndex, payload.index);
  const changeLines = applied.map(
    (c) =>
      `${formatEpisodeCode(c.parentIndex, c.index)}: ${cap(c.from)} -> ${cap(c.to)}`,
  );
  const summary = [
    `Show: ${payload.grandparentTitle}`,
    `Replayed: ${replayed}`,
    dryRun ? 'Dry run: yes' : null,
    'Changed:',
    ...changeLines,
  ]
    .filter(Boolean)
    .join('\n');

  ctx.changes.recordBatch({
    title: payload.grandparentTitle || 'Series rewind',
    summary,
    dryRun,
    changes: applied,
    meta: {
      showTitle: payload.grandparentTitle,
      showRatingKey: payload.grandparentRatingKey,
      replayedRatingKey: payload.ratingKey,
      replayedCode: replayed,
      accountId: payload.accountId,
    },
  });

  ctx.log.info(
    `${dryRun ? '[dry-run] ' : ''}Rewound ${payload.grandparentTitle} at ${replayed} (${applied.length} changes)`,
  );
  refreshPanel(ctx);
}

function cap(s) {
  return s === 'watched' ? 'Watched' : 'Unwatched';
}

function refreshPanel(ctx) {
  const batches = ctx.changes.list({ limit: 15 }).filter((b) => !b.undone);
  ctx.panels.add({
    title: 'Recent rewinds',
    empty: 'No rewinds yet',
    items: batches.map((b) => {
      const meta = b.payload?.meta || {};
      const count = (b.payload?.changes || []).length;
      return {
        id: String(b.id),
        title: b.title,
        subtitle: meta.replayedCode || '',
        meta: `${count} episode${count === 1 ? '' : 's'} changed${b.dry_run ? ' (dry run)' : ''} · ${b.created_at}`,
        actions: b.dry_run
          ? [{ id: 'dismiss', label: 'Dismiss' }]
          : [
              { id: 'undo', label: 'Undo', confirm: 'Undo this rewind?' },
              {
                id: 'forceUndo',
                label: 'Force undo',
                confirm:
                  'Force undo will overwrite episode watch states even if they changed after this rewind. Continue?',
              },
            ],
      };
    }),
    actions: {
      async dismiss({ body }) {
        ctx.changes.markUndone(Number(body.itemId));
        refreshPanel(ctx);
        return { message: 'Dismissed dry-run entry' };
      },
      async undo({ body, force }) {
        return undoBatch(ctx, Number(body.itemId), { force: Boolean(force) });
      },
      async forceUndo({ body }) {
        return undoBatch(ctx, Number(body.itemId), { force: true });
      },
    },
  });
}

async function undoBatch(ctx, batchId, { force = false } = {}) {
  const batch = ctx.changes.get(batchId);
  if (!batch) throw new Error('Rewind not found');
  if (batch.undone) throw new Error('Already undone');
  if (batch.dry_run) {
    ctx.changes.markUndone(batchId);
    refreshPanel(ctx);
    return { message: 'Dry-run entry dismissed' };
  }

  const original = batch.payload?.changes || [];
  const current = new Map();
  for (const change of original) {
    const state = await ctx.plex.getWatchState(change.ratingKey);
    if (!state) {
      throw new Error(
        `Cannot undo: failed to read current state for ${change.ratingKey}`,
      );
    }
    current.set(String(change.ratingKey), state.watched);
  }

  const plan = planUndo(original, current, { force });
  if (plan.conflicts.length && !force) {
    const detail = plan.conflicts
      .map(
        (c) =>
          `${formatEpisodeCode(c.parentIndex, c.index)} is ${c.current} (plugin left it ${c.pluginLeft})`,
      )
      .join('; ');
    refreshPanel(ctx);
    return {
      warning: `Some episodes changed since this rewind: ${detail}. Submit undo again with force if you want to overwrite.`,
    };
  }

  for (const change of plan.apply) {
    if (change.to === 'watched') {
      await ctx.plex.markWatched(change.ratingKey);
    } else {
      await ctx.plex.markUnwatched(change.ratingKey);
    }
  }

  ctx.changes.markUndone(batchId);
  ctx.log.info(
    `Undo rewind #${batchId}: ${plan.apply.length} restored, ${plan.conflicts.length} forced conflicts, ${plan.skipped.length} skipped`,
  );
  refreshPanel(ctx);
  return {
    message: `Undo complete (${plan.apply.length} episodes restored)`,
  };
}

// Allow host panel force via hidden field on a second attempt — expose helper for tests
export const _internal = { onPlayback, runRewind, undoBatch, refreshPanel };
