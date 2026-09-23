export function normalizeTitle(title) {
  let normalized = String(title || '')
    .toLowerCase()
    .trim();
  normalized = normalized.replace(/\s*\(\d{4}\)\s*$/, '');
  normalized = normalized.replace(/[^a-z0-9]+/gi, ' ');
  return normalized.replace(/\s+/g, ' ').trim();
}

export function extractYear(title) {
  const m = String(title || '').match(/\((\d{4})\)\s*$/);
  return m ? Number(m[1]) : null;
}

export function stripYearSuffix(title) {
  return String(title || '')
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .trim();
}

export function normalizePersonName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Exact normalized title match only (no substring). Optional year bonus/penalty.
 * @returns {number} score >= 100 for a usable hit; 0 = no match
 */
export function titleMatchScore(
  want,
  candidate,
  { wantYear = null, candidateYear = null } = {},
) {
  const a = normalizeTitle(want);
  const b = normalizeTitle(candidate);
  if (!a || !b || a !== b) return 0;

  let score = 100;
  if (wantYear != null && candidateYear != null) {
    const diff = Math.abs(Number(wantYear) - Number(candidateYear));
    if (diff === 0) score += 30;
    else if (diff === 1) score += 10;
    else return 0;
  }
  return score;
}

/** Normalize plex/epg type strings to `movie` | `tv` | null */
export function normalizeMediaType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'movie' || t === 'movies' || t === 'film') return 'movie';
  if (['show', 'shows', 'tv', 'episode', 'season', 'series'].includes(t)) {
    return 'tv';
  }
  return null;
}

export function mediaTypeAllowed(
  mediaType,
  { matchMovies = true, matchTv = true } = {},
) {
  const t = normalizeMediaType(mediaType);
  if (t === 'movie') return matchMovies !== false;
  if (t === 'tv') return matchTv !== false;
  return matchMovies !== false || matchTv !== false;
}
