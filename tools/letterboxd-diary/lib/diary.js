import { parseCsvObjects } from './csv.js';
import { matchFilm, normalizeTitle } from './library.js';
import { readZipTextFiles } from './zip.js';

const WATCH_FILES = ['watched.csv', 'diary.csv'];

/**
 * Films logged as watched in a Letterboxd export ZIP.
 * @param {Buffer|Uint8Array} buffer
 */
export function watchesFromExportZip(buffer) {
  return watchesFromFiles(readZipTextFiles(buffer));
}

/**
 * Diary rows have their own URI per entry, so films are deduped by title and year.
 * @param {Map<string, string>} files
 */
export function watchesFromFiles(files) {
  const byKey = new Map();
  let found = false;
  for (const name of WATCH_FILES) {
    const text = findFile(files, name);
    if (text == null) continue;
    found = true;
    for (const row of parseCsvObjects(text)) {
      const title = String(row.Name || '').trim();
      if (!title) continue;
      const year = numberOrNull(row.Year);
      const key = `${normalizeTitle(title)}|${year ?? ''}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        title,
        year,
        uri: String(row['Letterboxd URI'] || '').trim(),
      });
    }
  }
  if (!found) {
    throw new Error(
      'No watched.csv or diary.csv in that ZIP. Upload the export from Letterboxd Settings → Import & Export.',
    );
  }
  return [...byKey.values()];
}

/**
 * @param {Array<{ title: string, year: number|null, guids?: string[] }>} films
 * @param {ReturnType<import('./library.js').buildIndex>} index
 */
export function planDiary(films, index) {
  const plan = { toMark: [], alreadyWatched: [], missing: [], ambiguous: [] };
  const queued = new Set();
  for (const film of films) {
    const match = matchFilm(index, film);
    if (match.status === 'missing') {
      plan.missing.push(describeFilm(film));
      continue;
    }
    if (match.status === 'ambiguous') {
      plan.ambiguous.push({
        ...describeFilm(film),
        candidates: match.items.map((item) => describeItem(item)),
      });
      continue;
    }
    const unwatched = match.items.filter((item) => !(Number(item.viewCount) > 0));
    if (!unwatched.length) {
      plan.alreadyWatched.push(describeFilm(film));
      continue;
    }
    for (const item of unwatched) {
      const key = String(item.ratingKey);
      if (queued.has(key)) continue;
      queued.add(key);
      plan.toMark.push({ ...describeItem(item), letterboxdTitle: film.title });
    }
  }
  return plan;
}

/**
 * A film this tool marked has a view count of 1. A higher count means it was
 * played since, so undo leaves it alone unless forced.
 * @param {Array<{ ratingKey: string }>} changes
 * @param {Map<string, { viewCount: number }|null>} states
 */
export function planUnmark(changes, states, { force = false } = {}) {
  const apply = [];
  const conflicts = [];
  const skipped = [];
  for (const change of changes || []) {
    const state = states.get(String(change.ratingKey));
    const views = Number(state?.viewCount || 0);
    if (!state || views === 0) skipped.push(change);
    else if (views > 1 && !force) conflicts.push(change);
    else apply.push(change);
  }
  return { apply, conflicts, skipped };
}

function describeFilm(film) {
  return { title: film.title, year: film.year ?? null, uri: film.uri || '' };
}

function describeItem(item) {
  return {
    ratingKey: String(item.ratingKey),
    title: item.title || '',
    year: item.year ?? null,
    librarySectionID: item.librarySectionID ? String(item.librarySectionID) : null,
  };
}

function findFile(files, name) {
  for (const [path, text] of files) {
    if (path === name || path.endsWith(`/${name}`)) return text;
  }
  return null;
}

function numberOrNull(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
