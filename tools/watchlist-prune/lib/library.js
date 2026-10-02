/**
 * Match films against Plex items: a shared TMDb, IMDb, or Plex guid first,
 * otherwise an exact normalized title and year. More than one distinct film
 * is ambiguous. Copies of one film (same guid in two libraries) count once.
 */

const GUID_PATTERNS = [
  [/^(?:com\.plexapp\.agents\.)?(?:themoviedb|tmdb):\/\/(\d+)/i, (m) => `tmdb://${m[1]}`],
  [/^(?:com\.plexapp\.agents\.)?imdb:\/\/(tt\d+)/i, (m) => `imdb://${m[1].toLowerCase()}`],
  [/^plex:\/\/movie\/([a-z0-9]+)/i, (m) => `plex://movie/${m[1].toLowerCase()}`],
];

export function guidKeys(film) {
  const raw = [...(Array.isArray(film?.guids) ? film.guids : [])];
  if (typeof film?.guid === 'string') raw.push(film.guid);
  const keys = new Set();
  for (const value of raw) {
    const text = String(value || '').trim();
    for (const [pattern, toKey] of GUID_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        keys.add(toKey(match));
        break;
      }
    }
  }
  return [...keys];
}

export function normalizeTitle(title) {
  return String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function buildIndex(items) {
  const byGuid = new Map();
  const byTitle = new Map();
  for (const item of items || []) {
    if (!item) continue;
    for (const key of guidKeys(item)) push(byGuid, key, item);
    const title = normalizeTitle(item.title);
    if (title) push(byTitle, title, item);
  }
  return { byGuid, byTitle };
}

/**
 * @returns {{ status: 'matched'|'missing'|'ambiguous', items: any[] }}
 */
export function matchFilm(index, film) {
  const byGuid = uniqueItems(
    guidKeys(film).flatMap((key) => index.byGuid.get(key) || []),
  );
  if (byGuid.length) return result(byGuid);

  const title = normalizeTitle(film?.title);
  if (!title) return { status: 'missing', items: [] };
  const year = yearOf(film?.year);
  const candidates = (index.byTitle.get(title) || []).filter(
    (item) => year == null || yearOf(item.year) === year,
  );
  return result(uniqueItems(candidates));
}

export async function movieSectionIds(plex, selected) {
  const wanted = (Array.isArray(selected) ? selected : []).map(String).filter(Boolean);
  if (!wanted.length) return [];
  let libraries;
  try {
    libraries = await plex.getLibraries();
  } catch {
    return wanted;
  }
  const movies = new Set(
    (libraries || []).filter((lib) => lib.type === 'movie').map((lib) => String(lib.id)),
  );
  return wanted.filter((id) => movies.has(id));
}

export async function loadMovies(plex, sectionIds) {
  const items = [];
  for (const id of sectionIds) {
    let start = 0;
    for (;;) {
      const page = await plex.getLibraryItems(id, { type: 'movie', start, size: 200 });
      const rows = page?.items || [];
      items.push(...rows);
      start += rows.length;
      if (!rows.length || start >= Number(page?.total || 0)) break;
    }
  }
  return items;
}

function result(items) {
  if (!items.length) return { status: 'missing', items: [] };
  return { status: distinctFilms(items) === 1 ? 'matched' : 'ambiguous', items };
}

function distinctFilms(items) {
  const groups = [];
  for (const item of items) {
    const keys = guidKeys(item);
    if (!keys.length) {
      groups.push(new Set([`rk:${item.ratingKey}`]));
      continue;
    }
    const hits = groups.filter((group) => keys.some((key) => group.has(key)));
    if (!hits.length) {
      groups.push(new Set(keys));
      continue;
    }
    const [first, ...rest] = hits;
    for (const key of keys) first.add(key);
    for (const other of rest) {
      for (const key of other) first.add(key);
      groups.splice(groups.indexOf(other), 1);
    }
  }
  return groups.length;
}

function uniqueItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = String(item.ratingKey);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function yearOf(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function push(map, key, item) {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}
