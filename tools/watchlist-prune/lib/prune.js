import { buildIndex, matchFilm } from './library.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function watchlistMovies(watchlist) {
  return (watchlist || []).filter((entry) => entry?.type === 'movie' && entry.ratingKey);
}

/**
 * Watchlist movies that match a watched library film. Watchlist rating keys
 * are Discover keys, so removals always carry the watchlist entry's key.
 * @param {any[]} watchlist
 * @param {any[]} watchedItems library items, only those with viewCount > 0 count
 * @param {Set<string>} kept watchlist keys the user put back after a removal
 */
export function planWatchedRemovals(watchlist, watchedItems, kept = new Set()) {
  const candidates = watchlistMovies(watchlist).filter((entry) => !kept.has(String(entry.ratingKey)));
  const index = buildIndex(candidates);
  const removals = new Map();
  const ambiguous = [];
  for (const item of watchedItems || []) {
    if (!(Number(item?.viewCount) > 0)) continue;
    const match = matchFilm(index, item);
    if (match.status === 'ambiguous') {
      ambiguous.push({ title: item.title, year: item.year ?? null });
      continue;
    }
    if (match.status !== 'matched') continue;
    for (const entry of match.items) {
      const key = String(entry.ratingKey);
      if (!removals.has(key)) removals.set(key, { entry, reason: 'watched', libraryRatingKey: String(item.ratingKey) });
    }
  }
  return { removals: [...removals.values()], ambiguous };
}

/**
 * Record when each watchlist movie was first seen and forget ones that left.
 * @param {Record<string, string>} firstSeen ratingKey -> ISO time
 */
export function updateFirstSeen(firstSeen, watchlist, nowIso) {
  const next = {};
  for (const entry of watchlistMovies(watchlist)) {
    const key = String(entry.ratingKey);
    next[key] = firstSeen?.[key] || nowIso;
  }
  return next;
}

export function planAgeRemovals(watchlist, firstSeen, nowMs, maxAgeDays, kept = new Set()) {
  const days = Number(maxAgeDays);
  if (!(days > 0)) return [];
  const out = [];
  for (const entry of watchlistMovies(watchlist)) {
    const key = String(entry.ratingKey);
    if (kept.has(key)) continue;
    const seen = Date.parse(firstSeen?.[key] || '');
    if (!Number.isFinite(seen)) continue;
    const age = Math.floor((nowMs - seen) / DAY_MS);
    if (age >= days) out.push({ entry, reason: 'age', ageDays: age });
  }
  return out;
}
