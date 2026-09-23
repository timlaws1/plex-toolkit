import { normalizeTitle, extractYear, stripYearSuffix } from './normalize.js';
import {
  classifyChannel,
  pickPrimaryChannel,
  compactAlsoOn,
} from './channels.js';

const COLLAPSE_WINDOW_MS = 2 * 60 * 1000;
/** +1 channels typically air ~60 minutes later */
const PLUS1_OFFSET_MS = 60 * 60 * 1000;
const PLUS1_TOLERANCE_MS = 10 * 60 * 1000;

/**
 * Fetch XMLTV and return programmes inside the notify window.
 * Does not persist the full feed. Collapses regional/HD/+1 repeats.
 */
export async function fetchUpcomingAirings(
  epgUrl,
  windowDays = 7,
  { preferredRegion = null } = {},
) {
  const url = String(epgUrl || '').trim();
  if (!url) throw new Error('EPG URL is not configured');

  const res = await fetch(url, {
    headers: { 'User-Agent': 'PlexToolkit-Notifier/1.0' },
  });
  if (!res.ok) {
    throw new Error(`EPG fetch failed (${res.status})`);
  }
  const xml = await res.text();
  return parseXmltvWindow(xml, windowDays, { preferredRegion });
}

export function parseXmltvWindow(xml, windowDays = 7, { preferredRegion = null } = {}) {
  const now = Date.now();
  const until = now + Math.max(1, windowDays) * 24 * 60 * 60 * 1000;
  const channels = parseChannels(xml);
  const programmes = [];

  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const attrs = match[1];
    const body = match[2];
    const startRaw = attr(attrs, 'start');
    const stopRaw = attr(attrs, 'stop');
    const channelId = attr(attrs, 'channel') || '';
    const start = parseXmltvTime(startRaw);
    if (start == null || start.getTime() < now || start.getTime() > until) {
      continue;
    }
    const stop = parseXmltvTime(stopRaw);
    const rawTitle = textContent(body, 'title');
    if (!rawTitle) continue;

    let year = extractYear(rawTitle);
    const dateText = textContent(body, 'date');
    if (dateText) {
      const ym = dateText.match(/(\d{4})/);
      if (ym) year = Number(ym[1]);
    }

    const categories = allTextContent(body, 'category');
    const episodeNum = textContent(body, 'episode-num');
    const channelName = channels.get(channelId) || channelId;
    const classified = classifyChannel(channelName);
    const mediaTypeHint = inferMediaType(categories, episodeNum);

    programmes.push({
      programmeKey: `${channelId}|${startRaw}|${rawTitle}`,
      channel: channelName,
      channelId: channelId || null,
      channelFamily: classified.family,
      isHd: classified.isHd,
      isPlus1: classified.isPlus1,
      isRegional: classified.isRegional,
      region: classified.region,
      startsAt: start.toISOString(),
      endsAt: stop ? stop.toISOString() : null,
      startMs: start.getTime(),
      rawTitle,
      parsedYear: year,
      episodeNum,
      description: textContent(body, 'desc'),
      categories,
      mediaTypeHint,
      titleNormalized: normalizeTitle(stripYearSuffix(rawTitle)),
      channels: [
        {
          name: channelName,
          isHd: classified.isHd,
          isPlus1: classified.isPlus1,
          isRegional: classified.isRegional,
          region: classified.region,
          family: classified.family,
        },
      ],
    });
  }

  const collapsed = collapseAirings(programmes, COLLAPSE_WINDOW_MS, {
    preferredRegion,
  });
  collapsed.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return collapsed;
}

function mergeIntoGroup(existing, prog) {
  for (const ch of prog.channels || []) {
    if (!existing.channels.some((c) => c.name === ch.name)) {
      existing.channels.push(ch);
    }
  }
  if (prog.startMs < existing.startMs) {
    existing.startMs = prog.startMs;
    existing.startsAt = prog.startsAt;
    existing.endsAt = prog.endsAt ?? existing.endsAt;
  }
  if (
    (!existing.mediaTypeHint || existing.mediaTypeHint === 'unknown') &&
    prog.mediaTypeHint &&
    prog.mediaTypeHint !== 'unknown'
  ) {
    existing.mediaTypeHint = prog.mediaTypeHint;
  }
  if (prog.parsedYear && !existing.parsedYear) {
    existing.parsedYear = prog.parsedYear;
  }
}

function finalizeGroup(g, preferredRegion = null) {
  const primary = pickPrimaryChannel(g.channels, { preferredRegion });
  g.channel = primary?.name || g.channel;
  g.isHd = primary?.isHd || false;
  g.isPlus1 = primary?.isPlus1 || false;
  g.isRegional = primary?.isRegional || false;
  g.region = primary?.region || g.region || null;
  g.alsoOn = compactAlsoOn(g.channels, g.channel);
  delete g.startMs;
  return g;
}

/**
 * Collapse same title + channel family:
 * 1) near-simultaneous regionals/HD (2 min)
 * 2) +1 offset (~60 min) into the main listing
 */
export function collapseAirings(
  programmes,
  windowMs = COLLAPSE_WINDOW_MS,
  { preferredRegion = null } = {},
) {
  const groups = [];

  for (const prog of programmes) {
    const existing = groups.find(
      (g) =>
        g.titleNormalized === prog.titleNormalized &&
        g.channelFamily === prog.channelFamily &&
        Math.abs(g.startMs - prog.startMs) <= windowMs,
    );

    if (!existing) {
      groups.push({
        ...prog,
        channels: [...(prog.channels || [])],
      });
      continue;
    }
    mergeIntoGroup(existing, prog);
  }

  // Second pass: fold +1 listings into the primary ~60 minutes earlier
  const merged = [];
  const used = new Set();
  const sorted = groups.slice().sort((a, b) => a.startMs - b.startMs);

  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const g = sorted[i];

    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      const other = sorted[j];
      if (other.titleNormalized !== g.titleNormalized) continue;
      if (other.channelFamily !== g.channelFamily) continue;

      const delta = other.startMs - g.startMs;
      const nearPlus1 =
        Math.abs(delta - PLUS1_OFFSET_MS) <= PLUS1_TOLERANCE_MS;
      if (!nearPlus1) continue;

      const gHasPlus1 = g.channels.some((c) => c.isPlus1) || g.isPlus1;
      const oHasPlus1 = other.channels.some((c) => c.isPlus1) || other.isPlus1;

      if (gHasPlus1 || oHasPlus1) {
        mergeIntoGroup(g, other);
        used.add(j);
      }
    }

    merged.push(g);
  }

  return merged.map((g) => finalizeGroup(g, preferredRegion));
}

export function inferMediaType(categories, episodeNum) {
  const cats = (categories || []).map((c) => String(c).toLowerCase());
  if (cats.some((c) => /\b(movie|film|cinema)\b/.test(c))) return 'movie';
  if (cats.some((c) => /\b(tv|series|drama|comedy|soap|news|sport)\b/.test(c))) {
    return 'tv';
  }
  if (episodeNum) return 'tv';
  return 'unknown';
}

function parseChannels(xml) {
  const map = new Map();
  const re = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const id = attr(match[1], 'id');
    if (!id) continue;
    const name = textContent(match[2], 'display-name') || id;
    map.set(id, name);
  }
  return map;
}

function attr(attrs, name) {
  const m = String(attrs || '').match(
    new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'),
  );
  return m ? m[1] : '';
}

function textContent(body, tag) {
  const m = String(body || '').match(
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'),
  );
  if (!m) return null;
  return decodeXml(m[1]).trim() || null;
}

function allTextContent(body, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(body || '')) !== null) {
    const v = decodeXml(m[1]).trim();
    if (v) out.push(v);
  }
  return out;
}

function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function parseXmltvTime(value) {
  if (!value) return null;
  const m = String(value).match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/,
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  if (tz) {
    iso += `${tz.slice(0, 3)}:${tz.slice(3)}`;
  } else {
    iso += 'Z';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
