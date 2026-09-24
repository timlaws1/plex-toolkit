import { parseCsvObjects } from './csv.js';
import { readZipTextFiles } from './zip.js';

const FILE_KINDS = [
  { file: 'ratings.csv', kind: 'rating' },
  { file: 'watched.csv', kind: 'watched' },
  { file: 'watchlist.csv', kind: 'watchlist' },
  { file: 'diary.csv', kind: 'diary' },
  { file: 'reviews.csv', kind: 'review' },
];

/**
 * @param {Buffer|Uint8Array} buffer
 */
export function filmsFromExportZip(buffer) {
  const files = readZipTextFiles(buffer);
  const byUri = new Map();

  for (const { file, kind } of FILE_KINDS) {
    const text = findZipFile(files, file);
    if (!text) continue;
    for (const row of parseCsvObjects(text)) {
      const uri = String(row['Letterboxd URI'] || '').trim();
      const title = String(row.Name || '').trim();
      if (!uri || !title) continue;
      const year = numberOrNull(row.Year);
      const rating = numberOrNull(row.Rating);
      const tags = String(row.Tags || '').trim();
      const review = String(row.Review || '').trim().slice(0, 500);
      const current = byUri.get(uri) || {
        uri,
        title,
        year,
        rating: null,
        watched: 0,
        watchlist: 0,
        tags: '',
        review: '',
        activity: [],
      };
      if (year) current.year = year;
      if (rating != null) current.rating = rating;
      if (kind === 'watched' || kind === 'diary' || kind === 'review') current.watched = 1;
      if (kind === 'watchlist') current.watchlist = 1;
      if (tags) current.tags = tags;
      if (review) current.review = review;
      current.activity.push({
        kind,
        source: 'export',
        rssGuid: `export:${kind}:${uri}:${row.Date || row['Watched Date'] || ''}`,
        happenedOn: row['Watched Date'] || row.Date || null,
        rating,
        tags,
        review,
      });
      byUri.set(uri, current);
    }
  }

  if (byUri.size === 0) {
    throw new Error('No Letterboxd films found. Upload the ZIP from Letterboxd Settings → Import & Export.');
  }
  return [...byUri.values()];
}

function findZipFile(files, name) {
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
