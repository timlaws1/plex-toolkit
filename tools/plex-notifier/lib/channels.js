/**
 * Known Freeview brand families. Longer names first so ITV4 wins over ITV.
 */
const BRANDS = [
  'talking pictures tv',
  'bbc parliament',
  'bbc news',
  'bbc scotland',
  'bbc alba',
  'bbc one',
  'bbc two',
  'bbc three',
  'bbc four',
  'channel 4',
  'channel 5',
  'rte one',
  'rté one',
  'rte2',
  'rté2',
  'itv4',
  'itv3',
  'itv2',
  'itv',
  '5action',
  '5star',
  '5usa',
  '5select',
  'e4',
  'film4',
  'more4',
  '4seven',
  'sky arts',
  'sky mix',
  'dave',
  'yesterday',
  'drama',
  'gold',
  'w',
  'alibi',
  'quest',
  'really',
  'blaze',
  'legend',
  'horror',
  'cbs reality',
  'cbs drama',
  'cbs justice',
  'challenge',
];

export const REGION_TOKENS = [
  'yorks & lincs',
  'yorks and lincs',
  'west midlands',
  'east midlands',
  'midlands',
  'yorkshire',
  'north west',
  'north east',
  'east yorkshire',
  'west yorkshire',
  'south east',
  'south west',
  'east of england',
  'channel islands',
  'northern ireland',
  'oxford',
  'cambridge',
  'london',
  'wales',
  'scotland',
  'ulster',
  'border',
  'meridian',
  'central',
  'anglia',
  'granada',
  'tyne tees',
  'westcountry',
  'htv',
  'stv',
  'utv',
  'roi',
  'ni',
  'ci',
  'wm',
  'nw',
  'ne',
  'se',
  'sw',
  'em',
  'ee',
  'yh',
  'east',
  'west',
  'south',
  'north',
];

const HD_RE = /\b(?:u?hd|fhd|4k)\b/i;

/**
 * @param {string} displayName
 * @returns {{ family: string, display: string, isHd: boolean, isPlus1: boolean, isRegional: boolean, region: string|null }}
 */
export function classifyChannel(displayName) {
  const display = String(displayName || '').trim() || 'Unknown';
  let working = display
    .replace(/BBC\s*1\b/gi, 'BBC One')
    .replace(/BBC\s*2\b/gi, 'BBC Two')
    .replace(/ITV\s*1\b/gi, 'ITV')
    .replace(/RTÉ/gi, 'RTE')
    .replace(/\s+/g, ' ')
    .trim();

  const isPlus1 = /(?:\+1|plus\s*1)\b/i.test(working);
  const isHd = HD_RE.test(working);

  working = working
    .replace(/(?:\s+)?(?:\+1|plus\s*1)\b/gi, ' ')
    .replace(HD_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const lower = working.toLowerCase();
  let family = working;
  let isRegional = false;
  let region = extractRegionToken(lower);

  // Prefer known brand prefix (Channel 4 North → Channel 4)
  for (const brand of BRANDS) {
    if (lower === brand || lower.startsWith(`${brand} `)) {
      family = titleCaseBrand(brand);
      if (lower !== brand) isRegional = true;
      const after = lower.slice(brand.length).trim();
      region = extractRegionToken(after) || region;
      return { family, display, isHd, isPlus1, isRegional, region };
    }
  }

  // Fallback: strip longest region suffix
  const regions = REGION_TOKENS.slice().sort((a, b) => b.length - a.length);
  for (const regionToken of regions) {
    const re = new RegExp(`(?:\\s+|[-–—])${escapeRe(regionToken)}\\s*$`, 'i');
    if (re.test(lower)) {
      family = working.replace(re, '').trim();
      isRegional = true;
      region = regionToken;
      break;
    }
  }

  family = family.replace(/\s+/g, ' ').trim();

  return {
    family: family || display,
    display,
    isHd,
    isPlus1,
    isRegional,
    region,
  };
}

function extractRegionToken(text) {
  const lower = String(text || '').toLowerCase();
  const regions = REGION_TOKENS.slice().sort((a, b) => b.length - a.length);
  for (const region of regions) {
    if (lower.includes(region)) return region;
  }
  return null;
}

function titleCaseBrand(brand) {
  const special = {
    'bbc one': 'BBC One',
    'bbc two': 'BBC Two',
    'bbc three': 'BBC Three',
    'bbc four': 'BBC Four',
    'bbc news': 'BBC News',
    'bbc scotland': 'BBC Scotland',
    'bbc alba': 'BBC Alba',
    'bbc parliament': 'BBC Parliament',
    'channel 4': 'Channel 4',
    'channel 5': 'Channel 5',
    'rte one': 'RTE One',
    'rté one': 'RTE One',
    rte2: 'RTE2',
    'rté2': 'RTE2',
    itv: 'ITV',
    itv2: 'ITV2',
    itv3: 'ITV3',
    itv4: 'ITV4',
    '5action': '5ACTION',
    '5star': '5STAR',
    '5usa': '5USA',
    '5select': '5SELECT',
    e4: 'E4',
    film4: 'Film4',
    more4: 'More4',
    '4seven': '4seven',
    'talking pictures tv': 'Talking Pictures TV',
  };
  return special[brand] || brand.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Prefer preferred region when set; then non-+1; prefer HD when both exist;
 * then shorter (less regional) names.
 */
export function pickPrimaryChannel(channels, { preferredRegion = null } = {}) {
  if (!channels?.length) return null;
  const pref = String(preferredRegion || '')
    .trim()
    .toLowerCase();

  const enriched = channels.map((c) => {
    const classified = classifyChannel(c.name || c.display || '');
    return {
      ...c,
      name: c.name || c.display || classified.display,
      isHd: c.isHd ?? classified.isHd,
      isPlus1: c.isPlus1 ?? classified.isPlus1,
      isRegional: c.isRegional ?? classified.isRegional,
      region: c.region ?? classified.region,
      family: c.family || classified.family,
    };
  });

  const ranked = enriched.slice().sort((a, b) => {
    if (pref) {
      const aMatch = channelMatchesRegion(a, pref) ? 0 : 1;
      const bMatch = channelMatchesRegion(b, pref) ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
    }
    const score = (c) =>
      (c.isPlus1 ? 100 : 0) + (c.isHd ? 10 : 0) + (c.isRegional && !pref ? 1 : 0);
    const d = score(a) - score(b);
    if (d !== 0) return d;
    return String(a.name || '').length - String(b.name || '').length;
  });
  return ranked[0];
}

function channelMatchesRegion(channel, prefLower) {
  const name = String(channel.name || '').toLowerCase();
  const region = String(channel.region || '').toLowerCase();
  if (region && (region === prefLower || prefLower.includes(region) || region.includes(prefLower))) {
    return true;
  }
  return name.includes(prefLower);
}

/**
 * Compact "also on" list: hide HD/+1/regional clones of the primary family.
 * Returns labels like ["+1", "HD"] at most — never a long regional dump.
 */
export function compactAlsoOn(channels, primaryName) {
  if (!channels?.length) return [];
  const primary = classifyChannel(primaryName || '');
  let hasPlus1 = false;
  let hasHd = false;
  let hasOtherFamily = false;
  const otherFamilies = new Set();

  for (const c of channels) {
    const name = c.name || c.display || '';
    if (name === primaryName) continue;
    const classified = classifyChannel(name);
    if (classified.family === primary.family) {
      if (classified.isPlus1 || c.isPlus1) hasPlus1 = true;
      else if (classified.isHd || c.isHd) hasHd = true;
      continue;
    }
    hasOtherFamily = true;
    otherFamilies.add(classified.family);
  }

  const out = [];
  if (hasHd && !primary.isHd) out.push('HD');
  if (hasPlus1) out.push('+1');
  if (hasOtherFamily && otherFamilies.size <= 2) {
    for (const f of otherFamilies) out.push(f);
  } else if (hasOtherFamily) {
    out.push(`${otherFamilies.size} other channels`);
  }
  return out;
}

/**
 * Infer preferred Freeview region from Plex DVR channel titles.
 * Looks for regional BBC One / ITV variants.
 */
export function derivePreferredRegion(channelTitles = []) {
  const counts = new Map();
  for (const raw of channelTitles) {
    const classified = classifyChannel(raw);
    if (!classified.region) continue;
    const family = classified.family.toLowerCase();
    if (family !== 'bbc one' && family !== 'itv' && family !== 'bbc two') {
      continue;
    }
    const key = classified.region;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [region, count] of counts) {
    if (count > bestCount) {
      best = region;
      bestCount = count;
    }
  }
  if (!best) return null;
  return best.replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * UK Freeview radio brands (and anything with "radio" in the name).
 * These share the EPG with TV and must not match movie/TV watchlist titles.
 */
const RADIO_NAME_RE =
  /\b(?:radio|classic\s*fm|talk\s*sport|talksport|lbc|heart(?:\s|$)|capital(?:\s|$)|smooth(?:\s|$)|magic(?:\s|$)|kiss(?:\s|$)|absolute(?:\s|$)|scala|times\s*radio|greatest\s*hits|planet\s*rock|jazz\s*fm|asian\s*network|world\s*service|6\s*music|radio\s*x)\b/i;

/**
 * True for Freeview radio stations / radio-category listings.
 */
export function isRadioChannel(displayName) {
  const name = String(displayName || '').trim();
  if (!name) return false;
  return RADIO_NAME_RE.test(name);
}

/** Channels often on UK Freeview EPG that are outside typical England/Wales/Scotland viewing. */
export const DEFAULT_EXCLUDED_CHANNELS = [
  'France 24',
  'RTE One',
  'RTE2',
  'RTÉ One',
  'RTÉ2',
  'TG4',
];

/**
 * Normalize an exclude list from settings (or fall back to defaults when unset).
 * An explicit empty array means "exclude nothing".
 */
export function resolveExcludedChannels(raw) {
  if (raw === undefined || raw === null) {
    return DEFAULT_EXCLUDED_CHANNELS.slice();
  }
  if (!Array.isArray(raw)) {
    return DEFAULT_EXCLUDED_CHANNELS.slice();
  }
  return raw.map((s) => String(s || '').trim()).filter(Boolean);
}

function channelExcludeKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/rté/g, 'rte')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * True when the channel name or family matches an exclude entry.
 */
export function isChannelExcluded(channelName, excluded = []) {
  if (!excluded?.length) return false;
  const classified = classifyChannel(channelName);
  const nameKey = channelExcludeKey(channelName);
  const familyKey = channelExcludeKey(classified.family);
  for (const entry of excluded) {
    const key = channelExcludeKey(entry);
    if (!key) continue;
    if (nameKey === key || familyKey === key) return true;
    if (nameKey.includes(key) || key.includes(nameKey)) return true;
    if (familyKey.includes(key) || key.includes(familyKey)) return true;
  }
  return false;
}

/**
 * Build a lookup of DVR channel families / names for location filtering.
 */
export function buildDvrChannelIndex(channelTitles = []) {
  const families = new Set();
  const names = new Set();
  for (const raw of channelTitles) {
    const title = String(raw || '').trim();
    if (!title) continue;
    names.add(channelExcludeKey(title));
    const classified = classifyChannel(title);
    families.add(channelExcludeKey(classified.family));
  }
  return { families, names };
}

/**
 * True when an EPG channel is present on the user's DVR lineup.
 */
export function channelOnDvr(channelName, dvrIndex) {
  if (!dvrIndex?.families?.size && !dvrIndex?.names?.size) return true;
  const classified = classifyChannel(channelName);
  const nameKey = channelExcludeKey(channelName);
  const familyKey = channelExcludeKey(classified.family);
  if (dvrIndex.names.has(nameKey) || dvrIndex.families.has(familyKey)) {
    return true;
  }
  for (const n of dvrIndex.names) {
    if (n.includes(nameKey) || nameKey.includes(n)) return true;
  }
  for (const f of dvrIndex.families) {
    if (f === familyKey) return true;
  }
  return false;
}

/**
 * Drop airings outside the user's location filters.
 * - excludedChannels: never match (France 24, RTE, …)
 * - restrictToDvr + dvrTitles: only channels on the Plex DVR lineup
 */
export function filterAiringsByLocation(
  airings,
  {
    excludedChannels = DEFAULT_EXCLUDED_CHANNELS,
    restrictToDvr = false,
    dvrChannelTitles = [],
  } = {},
) {
  const excluded = resolveExcludedChannels(excludedChannels);
  const dvrIndex =
    restrictToDvr && dvrChannelTitles.length > 0
      ? buildDvrChannelIndex(dvrChannelTitles)
      : null;

  return (airings || []).filter((airing) => {
    const name = airing.channel || airing.channelFamily || '';
    if (isRadioChannel(name)) return false;
    if (String(airing.mediaTypeHint || '').toLowerCase() === 'radio') return false;

    const variants = airing.channels?.length
      ? airing.channels
      : [
          {
            name: airing.channel || airing.channelFamily || '',
            region: airing.region,
            family: airing.channelFamily,
            isHd: airing.isHd,
            isPlus1: airing.isPlus1,
            isRegional: airing.isRegional,
          },
        ];

    const kept = variants.filter((ch) => {
      const chName = ch.name || ch.display || '';
      if (isRadioChannel(chName)) return false;
      if (isChannelExcluded(chName, excluded)) return false;
      if (dvrIndex && !channelOnDvr(chName, dvrIndex)) return false;
      return true;
    });
    if (kept.length === 0) return false;

    airing.channels = kept;
    const primary = pickPrimaryChannel(kept, {
      preferredRegion: airing.preferredRegion || null,
    });
    if (primary) {
      airing.channel = primary.name;
      airing.isHd = primary.isHd || false;
      airing.isPlus1 = primary.isPlus1 || false;
      airing.isRegional = primary.isRegional || false;
      airing.region = primary.region || null;
      airing.channelFamily = primary.family || airing.channelFamily;
    }
    airing.alsoOn = compactAlsoOn(kept, airing.channel);
    return true;
  });
}

const ALSO_ON_KEEP_RE = /^(?:HD|\+1|\d+ other channels)$/i;

/**
 * Same location rules as Freeview matching, applied to queued digest rows.
 * Drops radio and excluded/off-DVR channels; strips those names from also-on.
 */
export function filterDigestItems(
  items,
  {
    excludedChannels = DEFAULT_EXCLUDED_CHANNELS,
    restrictToDvr = false,
    dvrChannelTitles = [],
  } = {},
) {
  const opts = { excludedChannels, restrictToDvr, dvrChannelTitles };
  return (items || []).flatMap((item) => {
    const channel = String(item?.channel || '').trim();
    const mediaType = String(item?.mediaType || '').toLowerCase();
    if (mediaType === 'radio') return [];
    if (channel && !channelAllowed(channel, opts)) return [];

    const alsoOn = (item?.alsoOn || []).filter((label) => {
      const text = String(label || '').trim();
      if (!text) return false;
      if (ALSO_ON_KEEP_RE.test(text)) return true;
      return channelAllowed(text, opts);
    });

    return [{ ...item, alsoOn }];
  });
}

function channelAllowed(channelName, opts) {
  const probe = {
    channel: channelName,
    channels: [{ name: channelName }],
  };
  return filterAiringsByLocation([probe], opts).length > 0;
}
