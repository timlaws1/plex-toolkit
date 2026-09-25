import { withinCap } from './ratings.js';

export const COOLDOWN_DAYS = 120;
export const MANAGED_SUMMARY = 'Managed by Plex Toolkit';

export function normName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function titleKey(title, year) {
  return `${normName(title)}|${year || ''}`;
}

export function splitList(value) {
  return String(value || '')
    .split(/[,|]/)
    .map((part) => normName(part))
    .filter(Boolean);
}

/**
 * @param {Array<{ rating?: number, genres?: string[], directors?: string[], actors?: string[] }>} films
 */
export function buildTaste(films) {
  const genres = new Map();
  const directors = new Map();
  const actors = new Map();
  for (const film of films) {
    const rating = Number(film.rating);
    if (!Number.isFinite(rating)) continue;
    const weight = (rating - 2.5) / 2.5;
    bump(genres, film.genres, weight);
    bump(directors, film.directors, weight * 1.5);
    bump(actors, (film.actors || []).slice(0, 6), weight * 0.45);
  }
  return { genres, directors, actors };
}

export function tasteIsEmpty(taste) {
  return taste.genres.size === 0 && taste.directors.size === 0 && taste.actors.size === 0;
}

export function scoreCandidate(candidate, taste) {
  let score = 0;
  for (const genre of candidate.genres || []) score += taste.genres.get(normName(genre)) || 0;
  for (const director of candidate.directors || []) {
    score += taste.directors.get(normName(director)) || 0;
  }
  for (const actor of (candidate.actors || []).slice(0, 8)) {
    score += taste.actors.get(normName(actor)) || 0;
  }
  if (candidate.similarToLiked) score += 1.2;
  return score;
}

/**
 * Pick films this person is likely to enjoy and can watch.
 * Popularity is not a ranking signal.
 */
export function selectRecommendations(candidates, taste, options = {}) {
  const count = Math.max(1, Number(options.count || 1));
  const recent = options.recentKeys || new Set();
  const include = splitList(options.genres);
  const exclude = splitList(options.excludedGenres);
  const emptyTaste = tasteIsEmpty(taste);
  const libraryOnly = options.output !== 'email' || !options.allowStreaming;
  const scored = [];

  for (const candidate of candidates) {
    if (candidate.watched) continue;
    if (!withinCap(candidate.certificate, options.certificateMax)) continue;
    if (recent.has(candidate.key) || (candidate.tmdbId && recent.has(`tmdb:${candidate.tmdbId}`))) continue;
    const minutes = candidate.runtimeMinutes;
    if (options.runtimeMin != null && minutes != null && minutes < Number(options.runtimeMin)) continue;
    if (options.runtimeMax != null && minutes != null && minutes > Number(options.runtimeMax)) continue;
    if (options.ratingMin != null && candidate.voteAverage != null && candidate.voteAverage < Number(options.ratingMin)) continue;
    if (options.ratingMax != null && candidate.voteAverage != null && candidate.voteAverage > Number(options.ratingMax)) continue;
    const genres = (candidate.genres || []).map(normName);
    if (include.length && !genres.some((genre) => include.includes(genre))) continue;
    if (exclude.length && genres.some((genre) => exclude.includes(genre))) continue;
    if (libraryOnly && !candidate.inLibrary) continue;

    let score = scoreCandidate(candidate, taste);
    if (!emptyTaste && score <= 0 && !candidate.similarToLiked) continue;
    if (options.preferPlex && candidate.inLibrary) score += 1.1;
    scored.push({ ...candidate, score });
  }

  scored.sort((a, b) => b.score - a.score || String(a.title).localeCompare(String(b.title)));
  const picked = [];
  const seen = new Set();
  for (const row of scored) {
    if (seen.has(row.key)) continue;
    seen.add(row.key);
    picked.push(row);
    if (picked.length >= count) break;
  }
  return picked;
}

export function tmdbIdFromGuids(guids) {
  for (const guid of guids || []) {
    const match = String(guid).match(/(?:themoviedb|tmdb)[^0-9]*(\d+)/i);
    if (match) return Number(match[1]);
  }
  return null;
}

function bump(map, names, weight) {
  for (const name of names || []) {
    const key = normName(name);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + weight);
  }
}
