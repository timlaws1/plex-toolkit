import {
  refreshHistory,
  refreshWatchlist,
  getHistoryIndex,
  searchPeople,
} from './lib/history.js';
import {
  getTrackedPeople,
  trackPerson,
  untrackPerson,
  searchTmdbPeople,
  runMatch,
  sendDigest,
  getPendingDigest,
  getLastMatch,
} from './lib/match.js';
import { getTmdbConfig } from './lib/tmdb.js';
import { renderApp } from './lib/ui.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export async function activate(ctx) {
  ctx.log.info('Plex Notifier activated');

  const settings = ctx.settings.get();
  if (settings.enabled !== false) {
    // Run once on activate so a fresh boot does not wait 12 hours.
    void scheduledRefresh(ctx);
    void scheduledMatch(ctx);
    ctx.scheduler.every(12 * HOUR_MS, () => scheduledRefresh(ctx), 'history-refresh');
    ctx.scheduler.every(12 * HOUR_MS, () => scheduledMatch(ctx), 'epg-match');
    ctx.scheduler.every(DAY_MS, () => scheduledDigest(ctx), 'digest');
  }

  ctx.panels.add({
    title: 'Plex Notifier',
    empty: 'Open the tool for rankings and Freeview matches.',
    items: [
      {
        id: 'open',
        title: 'Open notifier',
        subtitle: 'History · people · Freeview',
        meta: getHistoryIndex(ctx).updatedAt
          ? `History: ${getHistoryIndex(ctx).updatedAt}`
          : 'History not scanned yet',
        actions: [],
      },
    ],
    actions: {},
  });
}

export async function deactivate(ctx) {
  ctx.log.info('Plex Notifier deactivated');
}

export async function handleRequest(ctx, req) {
  if (req.method === 'POST') {
    return handlePost(ctx, req);
  }
  return handleGet(ctx, req);
}

async function handleGet(ctx, req) {
  const tab = String(req.query?.tab || 'actors');
  const q = String(req.query?.q || '').trim();
  const index = getHistoryIndex(ctx);
  const searchHits = q ? searchPeople(index, q) : [];
  const tracked = getTrackedPeople(ctx);
  const last = getLastMatch(ctx);
  const upcoming = (last?.matches || []).map((m) => ({
    title: m.title,
    mediaType: m.mediaType || null,
    channel: m.channel,
    alsoOn: m.alsoOn || [],
    startsAt: m.startsAt,
    reason: m.reason,
    personName: m.personName,
    alreadyNotified: m.alreadyNotified,
  }));

  const settings = ctx.settings.get();
  const tmdbConfigured = Boolean(getTmdbConfig(settings).apiKey);
  let tmdbHits = [];
  let tmdbError = null;
  if (q && tmdbConfigured) {
    try {
      tmdbHits = await searchTmdbPeople(ctx, q);
    } catch (err) {
      tmdbError = err.message;
    }
  } else if (q && !tmdbConfigured) {
    tmdbError = 'Set a TMDB API key in plugin settings to search people.';
  }

  return {
    title: 'Plex Notifier',
    body: renderApp({
      tab: ['actors', 'directors', 'writers', 'genres'].includes(tab)
        ? tab
        : 'actors',
      q,
      index,
      searchHits,
      tmdbHits,
      tmdbConfigured,
      tmdbError,
      tracked,
      upcoming,
      pending: getPendingDigest(ctx),
      statusMessage: req.query?.msg ? String(req.query.msg) : null,
    }),
  };
}

async function handlePost(ctx, req) {
  const action = String(req.body?.action || '');
  const tab = String(req.body?.tab || 'actors');
  const q = String(req.body?.q || '');
  let message = 'Done';

  try {
    if (action === 'refresh') {
      const index = await refreshHistory(ctx);
      let watchlistCount = 0;
      try {
        const wl = await refreshWatchlist(ctx);
        watchlistCount = wl.count;
      } catch (err) {
        ctx.log.warn(`Watchlist refresh failed: ${err.message}`);
      }
      message = `History refreshed (${index.stats.watchedMovies} movies, ${index.stats.watchedShows} shows). Watchlist: ${watchlistCount} titles`;
    } else if (action === 'watchlist') {
      const wl = await refreshWatchlist(ctx);
      message = `Watchlist synced: ${wl.count} titles`;
    } else if (action === 'match') {
      let watchlistCount = 0;
      try {
        const wl = await refreshWatchlist(ctx);
        watchlistCount = wl.count;
      } catch (err) {
        ctx.log.warn(`Watchlist refresh failed: ${err.message}`);
      }
      const result = await runMatch(ctx, { forceFilmography: true });
      const recNote =
        result.recorded > 0
          ? `; scheduled ${result.recorded} recording(s)`
          : result.recordErrors?.length
            ? `; DVR: ${result.recordErrors[0]}`
            : '';
      message = `Matched ${result.matchCount} titles (${result.watchlistHits || 0} watchlist, ${result.personHits || 0} tracked people; ${watchlistCount} watchlist synced)${recNote}`;
    } else if (action === 'digest') {
      const result = await sendDigest(ctx);
      message = result.message;
    } else if (action === 'track') {
      message = await handleTrack(ctx, req.body);
    } else if (action === 'untrack') {
      untrackPerson(ctx, req.body?.nameKey || req.body?.tmdbPersonId || req.body?.name);
      message = 'Removed from tracked people';
    } else {
      message = 'Unknown action';
    }
  } catch (err) {
    return {
      redirect: `/plugins/plex-notifier/app?tab=${encodeURIComponent(tab)}&q=${encodeURIComponent(q)}&msg=${encodeURIComponent(err.message)}`,
      message: err.message,
      flash: 'error',
    };
  }

  return {
    redirect: `/plugins/plex-notifier/app?tab=${encodeURIComponent(tab)}&q=${encodeURIComponent(q)}&msg=${encodeURIComponent(message)}`,
    message,
    flash: 'ok',
  };
}

async function handleTrack(ctx, body) {
  const name = String(body?.name || '').trim();
  let tmdbPersonId = Number(body?.tmdbPersonId);
  let profilePath = body?.profilePath || null;

  if ((!Number.isFinite(tmdbPersonId) || tmdbPersonId <= 0) && body?.resolveTmdb === '1') {
    const results = await searchTmdbPeople(ctx, name);
    const best = results[0];
    if (!best) {
      throw new Error(`No TMDB person found for “${name}”`);
    }
    tmdbPersonId = best.tmdbPersonId;
    profilePath = best.profilePath;
  }

  if (!Number.isFinite(tmdbPersonId) || tmdbPersonId <= 0) {
    throw new Error('Track a person from TMDB search results (requires TMDB API key)');
  }

  trackPerson(ctx, {
    name: name || `Person ${tmdbPersonId}`,
    tmdbPersonId,
    profilePath,
  });
  return `Tracking ${name} (TMDB #${tmdbPersonId})`;
}

async function scheduledRefresh(ctx) {
  const settings = ctx.settings.get();
  if (settings.enabled === false) return;
  try {
    await refreshHistory(ctx);
    await refreshWatchlist(ctx);
    ctx.log.info('Scheduled history refresh complete');
  } catch (err) {
    ctx.log.error(`Scheduled history refresh failed: ${err.message}`);
  }
}

async function scheduledMatch(ctx) {
  const settings = ctx.settings.get();
  if (settings.enabled === false) return;
  try {
    await refreshWatchlist(ctx);
    const result = await runMatch(ctx);
    ctx.log.info(
      `Scheduled match: ${result.matchCount} matches / ${result.airings} airings (${result.personHits || 0} people)`,
    );
  } catch (err) {
    ctx.log.error(`Scheduled match failed: ${err.message}`);
  }
}

async function scheduledDigest(ctx) {
  const settings = ctx.settings.get();
  if (settings.enabled === false) return;
  try {
    const pending = getPendingDigest(ctx);
    if (pending.length === 0) return;
    const result = await sendDigest(ctx);
    ctx.log.info(result.message);
  } catch (err) {
    ctx.log.error(`Scheduled digest failed: ${err.message}`);
  }
}
