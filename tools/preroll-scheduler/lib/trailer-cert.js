import path from 'node:path';
import { toBbfc } from '../../scheduled-recommendations/lib/ratings.js';
import { absoluteItemPath } from './media.js';

/**
 * @param {import('better-sqlite3').Statement|{ all: (...args: unknown[]) => unknown[] }} sql scoped prepare
 * @returns {Map<string, string|null>}
 */
export function loadTrailerCertificatesByPath(sql) {
  /** @type {Map<string, string|null>} */
  const map = new Map();
  let rows;
  try {
    rows = sql
      .prepare(
        `SELECT file_path, certificate FROM trailer_downloads
         WHERE removed_at IS NULL AND file_path IS NOT NULL`,
      )
      .all();
  } catch {
    return map;
  }
  for (const row of rows) {
    const key = path.resolve(String(row.file_path));
    map.set(key, row.certificate || null);
  }
  return map;
}

/**
 * Keep items with no fetcher cert record; otherwise require BBFC-normalised match.
 * @param {object[]} items preroll_items rows
 * @param {{ folder_path: string }} bucket
 * @param {Map<string, string|null>} certByPath
 * @param {string|null} movieCertBbfc
 */
export function filterItemsByMovieCertificate(
  items,
  bucket,
  certByPath,
  movieCertBbfc,
) {
  if (!movieCertBbfc || certByPath.size === 0) {
    return { items: items || [], filtered: false };
  }

  const enabled = (items || []).filter(
    (it) =>
      (it.enabled === 1 || it.enabled === true || it.enabled == null) &&
      !(it.missing === 1 || it.missing === true),
  );
  const matched = enabled.filter((item) => {
    const abs = path.resolve(
      absoluteItemPath(bucket.folder_path, item.relative_path),
    );
    if (!certByPath.has(abs)) return true;
    const trailerCert = toBbfc(certByPath.get(abs));
    if (!trailerCert) return true;
    return trailerCert === movieCertBbfc;
  });

  if (matched.length === 0) {
    return { items: enabled, filtered: false, fallback: true };
  }
  return { items: matched, filtered: true, fallback: false };
}

export { toBbfc };
