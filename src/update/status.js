import { canApplyUpdate, readUpdateResult } from './apply.js';
import {
  formatCommitDate,
  publishedRevision,
  readLocalRevision,
  readPackageVersion,
  repoSlug,
  revisionsDiffer,
  shortRevision,
} from './version.js';

let cached = localStatus();
let checkedAt = 0;

function localStatus(extra = {}) {
  const revision = readLocalRevision();
  return {
    version: process.env.APP_VERSION || readPackageVersion(),
    revision,
    revisionShort: shortRevision(revision) || 'local',
    latestRevision: null,
    latestShort: '',
    latestMessage: '',
    latestDate: '',
    updateAvailable: false,
    canApply: false,
    stateLabel: revision ? 'Checking for updates' : 'Development build',
    ...extra,
  };
}

export function getUpdateStatus() {
  return cached;
}

export async function refreshUpdateStatus(fetchFn = fetch, { force = false } = {}) {
  if (!force && checkedAt && Date.now() - checkedAt < 10 * 60 * 1000) {
    return cached;
  }
  const revision = readLocalRevision();
  const base = localStatus();
  let canApply = false;
  try {
    canApply = await canApplyUpdate();
  } catch {
    canApply = false;
  }

  if (!publishedRevision()) {
    cached = { ...base, canApply, updateAvailable: false, stateLabel: 'Development build' };
    checkedAt = Date.now();
    return cached;
  }

  if (!revision) {
    cached = { ...base, canApply, stateLabel: 'Development build' };
    checkedAt = Date.now();
    return cached;
  }

  try {
    const res = await fetchFn(
      `https://api.github.com/repos/${repoSlug()}/commits/main`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'plex-toolkit',
        },
      },
    );
    if (!res.ok) {
      throw new Error(`GitHub returned HTTP ${res.status}`);
    }
    const data = await res.json();
    const latestRevision = data.sha || null;
    const updateAvailable = revisionsDiffer(revision, latestRevision);
    cached = {
      ...base,
      canApply,
      latestRevision,
      latestShort: shortRevision(latestRevision),
      latestMessage: String(data.commit?.message || '').split('\n')[0],
      latestDate: formatCommitDate(
        data.commit?.committer?.date || data.commit?.author?.date,
      ),
      updateAvailable,
      stateLabel: updateAvailable ? 'Update available' : 'Up to date',
    };
  } catch {
    cached = {
      ...base,
      canApply,
      stateLabel: "Couldn't check for updates",
    };
  }
  checkedAt = Date.now();
  return cached;
}

export function updateCheckedAt() {
  return checkedAt;
}

export { readUpdateResult };
