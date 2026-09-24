import path from 'node:path';

/**
 * Parse MEDIA_ROOTS env (semicolon-separated). Empty/unset → null (unrestricted).
 * @param {string|undefined|null} raw
 * @returns {string[]|null}
 */
export function parseMediaRoots(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const roots = String(raw)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
  return roots.length ? roots : null;
}

/**
 * @param {string} candidate
 * @param {string[]|null} roots null = unrestricted
 */
export function assertPathAllowed(candidate, roots) {
  const resolved = path.resolve(candidate);
  if (!roots || roots.length === 0) return resolved;
  for (const root of roots) {
    const rel = path.relative(root, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return resolved;
    }
  }
  throw new Error(`Path is outside allowed media roots: ${resolved}`);
}
