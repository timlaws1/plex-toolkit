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
 * @typedef {{
 *   bucketId: number,
 *   bucketName?: string,
 *   count: number,
 *   items: Item[],
 *   usedIds?: Set<number>|number[],
 *   certFallback?: boolean,
 * }} Alternative
 */

/**
 * Pick from ordered groups: every group plays (AND), and exactly one
 * alternative within a group plays (OR).
 * @param {Alternative[][]} groups
 * @param {'random'|'random_avoid_repeats'} mode
 * @param {{ excludeIds?: Set<number>|number[], random?: () => number }} options
 * @returns {{ picks: { groupIndex: number, alternative: Alternative, selected: Item[], nextUsedIds: number[] }[], warnings: string[] }}
 */
export function selectFromGroups(groups, mode = 'random', options = {}) {
  const rand = options.random || Math.random;
  const picks = [];
  const warnings = [];
  /** @type {Map<number, number[]>} history carried across steps sharing a bucket */
  const usedByBucket = new Map();

  const run = (alt) =>
    selectFromBucket(
      alt.items,
      alt.count,
      mode,
      usedByBucket.get(alt.bucketId) ?? alt.usedIds ?? [],
      { excludeIds: options.excludeIds, random: rand },
    );
  const accept = (groupIndex, alt, result) => {
    usedByBucket.set(alt.bucketId, result.nextUsedIds);
    picks.push({ groupIndex, alternative: alt, ...result });
  };

  (groups || []).forEach((group, groupIndex) => {
    const alts = (group || []).filter(Boolean);
    if (alts.length === 0) return;

    if (alts.length === 1) {
      const alt = alts[0];
      const result = run(alt);
      for (const w of result.warnings) warnings.push(`${labelOf(alt)}: ${w}`);
      if (result.selected.length > 0) accept(groupIndex, alt, result);
      return;
    }

    for (const alt of orderAlternatives(alts, rand)) {
      const result = run(alt);
      if (result.selected.length === 0) continue;
      for (const w of result.warnings) warnings.push(`${labelOf(alt)}: ${w}`);
      accept(groupIndex, alt, result);
      return;
    }
    warnings.push(
      `None of ${alts.map(labelOf).join(' / ')} had videos to play`,
    );
  });

  return { picks, warnings };
}

/**
 * Certificate-matched alternatives first, then ones that can fill their count,
 * then ones with any playable video. Random within each tier.
 * @param {Alternative[]} alts
 * @param {() => number} rand
 */
function orderAlternatives(alts, rand) {
  const tiers = [[], [], [], [], []];
  for (const alt of alts) {
    const playable = playableCount(alt.items);
    const certOffset = alt.certFallback ? 2 : 0;
    if (playable === 0) tiers[4].push(alt);
    else if (playable >= Math.max(1, Number(alt.count) || 1)) {
      tiers[certOffset].push(alt);
    } else tiers[certOffset + 1].push(alt);
  }
  return tiers.flatMap((tier) => shuffle(tier, rand));
}

function playableCount(items) {
  return (items || []).filter(
    (it) =>
      (it.enabled === 1 || it.enabled === true || it.enabled == null) &&
      !(it.missing === 1 || it.missing === true),
  ).length;
}

function shuffle(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function labelOf(alt) {
  return alt.bucketName || `Bucket #${alt.bucketId}`;
}

/**
 * Dense group positions for steps in form order. Steps sharing a `group`
 * value with the previous step are OR alternatives; steps without one each
 * get their own group.
 * @param {{ group?: number }[]} steps
 * @returns {number[]}
 */
export function stepGroupPositions(steps) {
  const positions = [];
  let current = -1;
  let prevGroup;
  (steps || []).forEach((step, i) => {
    const group = step.group;
    if (i === 0 || group == null || group !== prevGroup) current += 1;
    positions.push(current);
    prevGroup = group;
  });
  return positions;
}

/**
 * Split ordered step rows into consecutive groups by `group_position`.
 * @template {{ group_position?: number|null }} T
 * @param {T[]} rows
 * @returns {T[][]}
 */
export function groupSteps(rows) {
  const groups = [];
  let prev;
  (rows || []).forEach((row, i) => {
    const key = row.group_position ?? `row-${i}`;
    if (groups.length === 0 || key !== prev) groups.push([]);
    groups[groups.length - 1].push(row);
    prev = key;
  });
  return groups;
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
