/**
 * Parse Plex GUID strings into identity keys.
 * @param {string|string[]|null|undefined} guid
 * @param {string|null} [typeHint]
 * @returns {{ tmdbId: number|null, imdbId: string|null, mediaType: string|null, keys: string[] }}
 */
export function parseGuids(guid, typeHint = null) {
  const candidates = flatten(guid);
  let tmdbId = null;
  let imdbId = null;
  let mediaType = normalizeMediaType(typeHint);

  for (const value of candidates) {
    if (tmdbId == null) {
      const m = value.match(/(?:tmdb|themoviedb)[:\/]+(?:(?:movie|show|tv)[:\/]+)?(\d+)/i);
      if (m) tmdbId = Number(m[1]);
    }
    if (imdbId == null) {
      const mTt = value.match(/imdb[:\/]+(tt\d+)/i);
      if (mTt) {
        imdbId = mTt[1];
      } else {
        const mNum = value.match(/imdb[:\/]+(\d+)/i);
        if (mNum) imdbId = `tt${mNum[1]}`;
      }
    }
    if (mediaType == null) {
      const lower = value.toLowerCase();
      if (lower.includes('show') || lower.includes('/tv') || lower.includes(':tv')) {
        mediaType = 'tv';
      } else if (lower.includes('movie')) {
        mediaType = 'movie';
      }
    }
  }

  const keys = [];
  if (tmdbId != null && mediaType) keys.push(`tmdb:${mediaType}:${tmdbId}`);
  if (imdbId) keys.push(`imdb:${imdbId}`);
  for (const c of candidates) {
    if (c && !keys.includes(c)) keys.push(c);
  }

  return { tmdbId, imdbId, mediaType, keys };
}

/**
 * @param {{ guids?: string[], guid?: string|null, type?: string|null }} item
 */
export function identityKeys(item) {
  const typeHint =
    item?.type === 'show' || item?.type === 'episode' ? 'tv' : item?.type || null;
  const guids = [
    ...(Array.isArray(item?.guids) ? item.guids : []),
    ...(item?.guid ? [item.guid] : []),
  ];
  return parseGuids(guids, typeHint);
}

function flatten(guid) {
  if (guid == null) return [];
  if (typeof guid === 'string') return [guid];
  if (!Array.isArray(guid)) return [];
  const out = [];
  for (const item of guid) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item.id === 'string') out.push(item.id);
  }
  return out;
}

function normalizeMediaType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'movie' || t === 'movies') return 'movie';
  if (['show', 'shows', 'tv', 'episode', 'season'].includes(t)) return 'tv';
  return null;
}

export function titleKey(mediaType, tmdbId, imdbId, fallback) {
  if (tmdbId != null && mediaType) return `tmdb:${mediaType}:${tmdbId}`;
  if (imdbId) return `imdb:${imdbId}`;
  return fallback || null;
}
