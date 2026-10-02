import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
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

function isWithin(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

function realRoot(root) {
  try {
    return fs.realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}

/**
 * Real path of `resolved`, or of its nearest existing parent joined with the missing tail.
 * @param {string} resolved
 */
function realPathOrParent(resolved) {
  const missing = [];
  let probe = resolved;
  while (!lstatOrNull(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    missing.unshift(path.basename(probe));
    probe = parent;
  }
  return path.join(fs.realpathSync.native(probe), ...missing);
}

/**
 * Allow a path only when it, and the real path behind it, sit under a media root.
 * A symbolic link as the final component is refused unless it is a configured root.
 * @param {string} candidate
 * @param {string[]|null} roots null = unrestricted
 */
export function assertPathAllowed(candidate, roots) {
  const resolved = path.resolve(candidate);
  if (!roots || roots.length === 0) return resolved;

  const lexicalRoots = roots.map((r) => path.resolve(r));
  if (!lexicalRoots.some((root) => isWithin(root, resolved))) {
    throw new Error(`Path is outside allowed media roots: ${resolved}`);
  }

  const isRoot = lexicalRoots.some((root) => path.relative(root, resolved) === '');
  if (!isRoot && lstatOrNull(resolved)?.isSymbolicLink()) {
    throw new Error(`Path is a symbolic link: ${resolved}`);
  }

  let real;
  try {
    real = realPathOrParent(resolved);
  } catch (err) {
    throw new Error(`Path cannot be resolved: ${resolved} (${err.code || err.message})`);
  }
  if (!lexicalRoots.map(realRoot).some((root) => isWithin(root, real))) {
    throw new Error(`Path is outside allowed media roots: ${resolved}`);
  }
  return resolved;
}

/**
 * Write via a temp file in the same directory, then rename over the destination, so a
 * symbolic link planted at the destination is replaced rather than followed.
 * @param {string} dest already checked with assertPathAllowed
 * @param {string|Uint8Array} data
 */
export async function writeFileReplacing(dest, data) {
  const dir = path.dirname(dest);
  const tmp = path.join(
    dir,
    `.${path.basename(dest)}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );
  await fsp.writeFile(tmp, data, { flag: 'wx' });
  try {
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}
