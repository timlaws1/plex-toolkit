import path from 'node:path';

/**
 * Rewrite a Toolkit-local absolute path to the path Plex Media Server sees.
 * @param {string} localPath
 * @param {{ toolkitPrefix?: string|null, plexPrefix?: string|null }} prefixes
 */
export function toPlexPath(localPath, prefixes = {}) {
  const toolkitPrefix = normalizePrefix(prefixes.toolkitPrefix);
  const plexPrefix = normalizePrefix(prefixes.plexPrefix);
  if (!toolkitPrefix || plexPrefix == null || plexPrefix === '') {
    return localPath;
  }
  const normalized = path.resolve(localPath);
  const prefixResolved = path.resolve(toolkitPrefix);
  const rel = path.relative(prefixResolved, normalized);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return localPath;
  }
  const plexBase = plexPrefix.replace(/[/\\]+$/, '');
  const joined = `${plexBase}/${rel.split(path.sep).join('/')}`;
  // Preserve Windows-style separators when the plex prefix uses them
  if (plexPrefix.includes('\\') && !plexPrefix.includes('/')) {
    return joined.replace(/\//g, '\\');
  }
  return joined.replace(/\\/g, '/');
}

/**
 * Build the CinemaTrailersPrerollID value: comma-separated sequential paths.
 * @param {string[]} paths
 */
export function buildPlexPrerollValue(paths) {
  return (paths || []).filter(Boolean).join(',');
}

/**
 * @param {string|null|undefined} prefix
 */
export function normalizePrefix(prefix) {
  if (prefix == null) return null;
  const trimmed = String(prefix).trim();
  return trimmed || null;
}

/**
 * Ensure a candidate path is under one of the allowed bucket folders.
 * @param {string} candidate
 * @param {string[]} allowedRoots
 */
export function isPathUnderRoots(candidate, allowedRoots) {
  const resolved = path.resolve(candidate);
  for (const root of allowedRoots || []) {
    const rootResolved = path.resolve(root);
    const rel = path.relative(rootResolved, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}
