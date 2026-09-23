/**
 * Pure rewind planner — no I/O.
 *
 * @param {Array<{ratingKey:string, parentIndex:number, index:number, viewCount:number, title?:string}>} episodes
 * @param {{ratingKey:string, parentIndex:number, index:number}} replayed
 * @param {{includeSpecials?: boolean}} [options]
 * @returns {{changes: Array<{ratingKey:string, parentIndex:number, index:number, title?:string, from: 'watched'|'unwatched', to: 'watched'|'unwatched'}>, ordered: typeof episodes}}
 */
export function planRewind(episodes, replayed, options = {}) {
  const includeSpecials = Boolean(options.includeSpecials);
  let list = [...episodes].sort((a, b) => {
    if (a.parentIndex !== b.parentIndex) return a.parentIndex - b.parentIndex;
    return a.index - b.index;
  });

  if (!includeSpecials) {
    list = list.filter((e) => Number(e.parentIndex) !== 0);
  }

  const replayedKey = String(replayed.ratingKey);
  const pivot = list.findIndex((e) => String(e.ratingKey) === replayedKey);
  if (pivot < 0) {
    return { changes: [], ordered: list, error: 'Replayed episode not found in series list' };
  }

  const changes = [];
  for (let i = 0; i < list.length; i++) {
    const ep = list[i];
    const watched = Number(ep.viewCount || 0) > 0;
    if (i <= pivot) {
      if (!watched) {
        changes.push({
          ratingKey: String(ep.ratingKey),
          parentIndex: ep.parentIndex,
          index: ep.index,
          title: ep.title,
          from: 'unwatched',
          to: 'watched',
        });
      }
    } else if (watched) {
      changes.push({
        ratingKey: String(ep.ratingKey),
        parentIndex: ep.parentIndex,
        index: ep.index,
        title: ep.title,
        from: 'watched',
        to: 'unwatched',
      });
    }
  }

  return { changes, ordered: list, error: null };
}

export function formatEpisodeCode(parentIndex, index) {
  const s = String(parentIndex).padStart(2, '0');
  const e = String(index).padStart(2, '0');
  return `S${s}E${e}`;
}

/**
 * Decide undo actions after re-reading current Plex state.
 *
 * @param {Array<{ratingKey:string, from:string, to:string}>} originalChanges
 * @param {Map<string, boolean>|Record<string, boolean>} currentWatchedByKey - true if currently watched
 * @param {{force?: boolean}} [options]
 */
export function planUndo(originalChanges, currentWatchedByKey, options = {}) {
  const force = Boolean(options.force);
  const getWatched = (key) => {
    if (currentWatchedByKey instanceof Map) return currentWatchedByKey.get(String(key));
    return currentWatchedByKey[String(key)];
  };

  const apply = [];
  const conflicts = [];
  const skipped = [];

  for (const change of originalChanges) {
    const key = String(change.ratingKey);
    const currentlyWatched = Boolean(getWatched(key));
    const expectedAfterPlugin = change.to === 'watched';

    if (currentlyWatched === expectedAfterPlugin) {
      apply.push({
        ratingKey: key,
        parentIndex: change.parentIndex,
        index: change.index,
        title: change.title,
        from: change.to,
        to: change.from,
      });
      continue;
    }

    // Diverged from what the plugin left behind
    conflicts.push({
      ratingKey: key,
      parentIndex: change.parentIndex,
      index: change.index,
      title: change.title,
      current: currentlyWatched ? 'watched' : 'unwatched',
      pluginLeft: change.to,
      restoreTo: change.from,
    });

    if (force) {
      apply.push({
        ratingKey: key,
        parentIndex: change.parentIndex,
        index: change.index,
        title: change.title,
        from: currentlyWatched ? 'watched' : 'unwatched',
        to: change.from,
      });
    } else {
      skipped.push({ ratingKey: key, reason: 'user_changed' });
    }
  }

  return { apply, conflicts, skipped };
}

export function titleMatch(haystack, needle) {
  return String(haystack || '').trim().toLowerCase() === String(needle || '').trim().toLowerCase();
}

export function isShowAllowed(showTitle, settings) {
  const exclude = settings.excludeShows || [];
  if (exclude.some((t) => titleMatch(showTitle, t))) return false;
  const include = settings.includeShows || [];
  if (include.length === 0) return true;
  return include.some((t) => titleMatch(showTitle, t));
}
