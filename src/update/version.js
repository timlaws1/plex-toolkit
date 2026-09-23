import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../config.js';

const REPO = process.env.UPDATE_REPO || 'timlaws1/plex-toolkit';
const DEFAULT_IMAGE = process.env.UPDATE_IMAGE || 'ghcr.io/timlaws1/plex-toolkit:latest';

export function repoSlug() {
  return REPO;
}

export function defaultImage() {
  return DEFAULT_IMAGE;
}

export function readPackageVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(config.root, 'package.json'), 'utf8'),
    );
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

export function publishedRevision() {
  const fromEnv = String(process.env.APP_REVISION || '').trim();
  if (!fromEnv || fromEnv === 'dev') return null;
  return fromEnv;
}

export function readLocalRevision() {
  const published = publishedRevision();
  if (published) return published;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: config.root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function shortRevision(sha) {
  const value = String(sha || '').trim();
  if (!value) return '';
  return value.slice(0, 7);
}

export function revisionsDiffer(local, remote) {
  if (!local || !remote) return false;
  if (local === 'dev') return false;
  return local !== remote;
}

export function splitImageRef(ref) {
  const raw = String(ref || '').trim();
  if (!raw || raw.startsWith('sha256:')) {
    return splitImageRef(DEFAULT_IMAGE);
  }
  const at = raw.lastIndexOf('@');
  if (at > 0 && raw.slice(at + 1).startsWith('sha256:')) {
    return { fromImage: raw.slice(0, at), tag: null };
  }
  const slash = raw.lastIndexOf('/');
  const colon = raw.lastIndexOf(':');
  if (colon > slash) {
    return { fromImage: raw.slice(0, colon), tag: raw.slice(colon + 1) };
  }
  return { fromImage: raw, tag: 'latest' };
}

export function imageRefFromInspect(inspect) {
  const configured = String(inspect?.Config?.Image || '').trim();
  if (configured && !configured.startsWith('sha256:')) return configured;
  return DEFAULT_IMAGE;
}

export function formatCommitDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}
