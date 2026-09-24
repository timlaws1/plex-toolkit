/**
 * @typedef {{ id: number, enabled?: number|boolean, missing?: number|boolean }} Item
 */

/**
 * @param {Item[]} items
 * @param {number} count
 * @param {'random'|'random_avoid_repeats'} mode
 * @param {Set<number>|number[]} usedIds previously used item ids for this bucket
 * @param {{ excludeIds?: Set<number>|number[], random?: () => number }} options
 * @returns {{ selected: Item[], nextUsedIds: number[], warnings: string[] }}
 */
export function selectFromBucket(
  items,
  count,
  mode = 'random',
  usedIds = [],
  options = {},
) {
  const warnings = [];
  const n = Math.max(0, Number(count) || 0);
  if (n === 0) return { selected: [], nextUsedIds: [...toSet(usedIds)], warnings };

  const enabled = (items || []).filter(
    (it) =>
      (it.enabled === 1 || it.enabled === true || it.enabled == null) &&
      !(it.missing === 1 || it.missing === true),
  );

  if (enabled.length === 0) {
    warnings.push('Bucket has no enabled videos');
    return { selected: [], nextUsedIds: [...toSet(usedIds)], warnings };
  }

  const exclude = toSet(options.excludeIds);
  const rand = options.random || Math.random;
  const used = toSet(usedIds);
  const selected = [];
  let workingUsed = new Set(used);

  for (let i = 0; i < n; i++) {
    let pool = enabled.filter((it) => !selected.some((s) => s.id === it.id));

    if (mode === 'random_avoid_repeats') {
      const unused = pool.filter((it) => !workingUsed.has(it.id));
      if (unused.length > 0) {
        pool = unused;
      } else {
        // Cycle complete — clear history for this bucket
        workingUsed = new Set();
        pool = enabled.filter((it) => !selected.some((s) => s.id === it.id));
      }
    }

    // Prefer excluding previous combination ids when alternatives exist
    if (exclude.size > 0) {
      const withoutExclude = pool.filter((it) => !exclude.has(it.id));
      if (withoutExclude.length > 0) pool = withoutExclude;
    }

    if (pool.length === 0) {
      warnings.push(`Could only select ${selected.length} of ${n} items`);
      break;
    }

    const pick = pool[Math.floor(rand() * pool.length)];
    selected.push(pick);
    workingUsed.add(pick.id);
  }

  // If avoid-repeats and every enabled item has now been used, clear for next cycle
  if (
    mode === 'random_avoid_repeats' &&
    enabled.length > 0 &&
    enabled.every((it) => workingUsed.has(it.id))
  ) {
    workingUsed = new Set();
  }

  return {
    selected,
    nextUsedIds: [...workingUsed],
    warnings,
  };
}

/**
 * Fingerprint a selected combination for Roll Again exclusion.
 * @param {{ id: number }[]} items
 */
export function combinationKey(items) {
  return (items || []).map((i) => i.id).join(',');
}

function toSet(value) {
  if (value instanceof Set) return new Set(value);
  return new Set((value || []).map(Number));
}

/**
 * Session key used for playback.started dedupe (matches SessionTracker).
 * @param {{ accountId?: string, sessionKey?: string, ratingKey?: string }} payload
 */
export function playbackSessionKey(payload) {
  const accountId = payload?.accountId || '0';
  const sessionKey = payload?.sessionKey || payload?.ratingKey || '';
  return `${accountId}:${sessionKey}`;
}
