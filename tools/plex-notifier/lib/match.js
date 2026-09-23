import {
  normalizeTitle,
  normalizePersonName,
  titleMatchScore,
  normalizeMediaType,
  mediaTypeAllowed,
} from './normalize.js';
import {
  getLibraryKeySet,
  getWatchlistItems,
} from './history.js';
import { fetchUpcomingAirings } from './epg.js';
import { createTmdbClient, getTmdbConfig } from './tmdb.js';
import {
  derivePreferredRegion,
  filterAiringsByLocation,
  resolveExcludedChannels,
} from './channels.js';

const TRACKED_KEY = 'trackedPeople';
const FILMOGRAPHY_CACHE_KEY = 'filmographyCache';
const SENT_KEY = 'sentTitles';
const DIGEST_KEY = 'pendingDigest';
const LAST_MATCH_KEY = 'lastMatch';
const RECORDED_KEY = 'recordedKeys';
const FILMOGRAPHY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getTrackedPeople(ctx) {
  const list = ctx.storage.get(TRACKED_KEY);
  return Array.isArray(list) ? list : [];
}

/**
 * Track a TMDB person. Requires tmdbPersonId for Freeview matching.
 */
export function trackPerson(ctx, person) {
  const name = String(person?.name || '').trim();
  const tmdbPersonId = Number(person?.tmdbPersonId);
  if (!name) return getTrackedPeople(ctx);

  const nameKey = normalizePersonName(name);
  const list = getTrackedPeople(ctx);

  if (Number.isFinite(tmdbPersonId) && tmdbPersonId > 0) {
    const existingIdx = list.findIndex(
      (p) =>
        Number(p.tmdbPersonId) === tmdbPersonId || p.nameKey === nameKey,
    );
    const entry = {
      name,
      nameKey,
      tmdbPersonId,
      profilePath: person.profilePath || null,
      trackedAt: new Date().toISOString(),
    };
    if (existingIdx >= 0) list[existingIdx] = entry;
    else list.push(entry);
  } else {
    // Name-only: keep listed but cannot match Freeview until re-tracked via TMDB
    if (list.some((p) => p.nameKey === nameKey)) return list;
    list.push({
      name,
      nameKey,
      tmdbPersonId: null,
      profilePath: null,
      trackedAt: new Date().toISOString(),
    });
  }

  ctx.storage.set(TRACKED_KEY, list);
  return list;
}

export function untrackPerson(ctx, nameKeyOrId) {
  const raw = String(nameKeyOrId || '').trim();
  const asId = Number(raw);
  const list = getTrackedPeople(ctx).filter((p) => {
    if (Number.isFinite(asId) && asId > 0 && Number(p.tmdbPersonId) === asId) {
      return false;
    }
    return p.nameKey !== normalizePersonName(raw);
  });
  ctx.storage.set(TRACKED_KEY, list);
  return list;
}

export async function searchTmdbPeople(ctx, query) {
  const settings = ctx.settings.get();
  const cfg = getTmdbConfig(settings);
  if (!cfg.apiKey) {
    throw new Error('Set a TMDB API key in plugin settings to search people');
  }
  const tmdb = createTmdbClient(cfg);
  return tmdb.searchPerson(query, { limit: 12 });
}

/**
 * Load (and cache) filmography for tracked people with TMDB ids.
 */
export async function loadFilmographyIndex(ctx, { force = false } = {}) {
  const settings = ctx.settings.get();
  const cfg = getTmdbConfig(settings);
  const tracked = getTrackedPeople(ctx).filter(
    (p) => Number(p.tmdbPersonId) > 0,
  );
  if (tracked.length === 0) {
    return { entries: [], people: 0, fromCache: true };
  }
  if (!cfg.apiKey) {
    throw new Error('Set a TMDB API key in plugin settings to match tracked people');
  }

  const tmdb = createTmdbClient(cfg);
  const cache = ctx.storage.get(FILMOGRAPHY_CACHE_KEY) || {};
  const now = Date.now();
  const entries = [];
  let fetched = 0;

  for (const person of tracked) {
    const id = String(person.tmdbPersonId);
    let bucket = cache[id];
    const stale =
      !bucket?.fetchedAt ||
      now - Date.parse(bucket.fetchedAt) > FILMOGRAPHY_TTL_MS;

    if (force || stale || !Array.isArray(bucket?.credits)) {
      const credits = await tmdb.personFilmography(person.tmdbPersonId);
      bucket = {
        fetchedAt: new Date().toISOString(),
        name: person.name,
        credits,
      };
      cache[id] = bucket;
      fetched += 1;
    }

    for (const credit of bucket.credits || []) {
      const titleNorm = normalizeTitle(credit.title);
      if (!titleNorm) continue;
      entries.push({
        titleNormalized: titleNorm,
        title: credit.title,
        year: credit.year,
        mediaType: credit.mediaType,
        tmdbId: credit.tmdbId,
        personName: person.name,
        tmdbPersonId: person.tmdbPersonId,
      });
    }
  }

  ctx.storage.set(FILMOGRAPHY_CACHE_KEY, cache);
  return { entries, people: tracked.length, fetched };
}

/**
 * Match an EPG airing against filmography entries (exact title; year when both known).
 */
export function findFilmographyHit(airing, entries, typeOpts = {}) {
  const want = airing.titleNormalized;
  if (!want || !entries?.length) return null;

  const epgType = normalizeMediaType(airing.mediaTypeHint);
  let best = null;
  let bestScore = -1;

  for (const entry of entries) {
    if (!mediaTypeAllowed(entry.mediaType, typeOpts)) continue;
    if (epgType && entry.mediaType && epgType !== entry.mediaType) continue;

    const score = titleMatchScore(want, entry.titleNormalized, {
      wantYear: airing.parsedYear,
      candidateYear: entry.year ?? null,
    });
    if (score <= 0) continue;
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  if (!best || bestScore < 100) return null;
  return best;
}

export function findWatchlistHit(airing, watchlistItems, typeOpts = {}) {
  const want = airing.titleNormalized;
  if (!want) return null;
  const year = airing.parsedYear;
  const epgType = normalizeMediaType(airing.mediaTypeHint);

  let best = null;
  let bestScore = -1;
  for (const item of watchlistItems) {
    const titleNorm = item.titleNormalized || normalizeTitle(item.title || '');
    if (!titleNorm) continue;

    const itemType =
      normalizeMediaType(item.type) ||
      normalizeMediaType(item.mediaType);
    if (!mediaTypeAllowed(itemType || 'unknown', typeOpts)) continue;
    if (epgType && itemType && epgType !== itemType) continue;

    const score = titleMatchScore(want, titleNorm, {
      wantYear: year,
      candidateYear: item.year ?? null,
    });
    if (score <= 0) continue;

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  if (!best || bestScore < 100) return null;

  const mediaType =
    normalizeMediaType(best.type) ||
    normalizeMediaType(best.mediaType) ||
    epgType ||
    'movie';

  return {
    title: best.title,
    year: best.year,
    mediaType,
    keys: best.keys || [],
    tmdbId: best.tmdbId ?? null,
    imdbId: best.imdbId ?? null,
    guids: Array.isArray(best.guids) ? best.guids : [],
    personNames: [],
    fromWatchlist: true,
  };
}

function airingAllowedBySettings(airing, typeOpts) {
  const hint = normalizeMediaType(airing.mediaTypeHint);
  if (!hint) return true;
  return mediaTypeAllowed(hint, typeOpts);
}

export function libraryHasTitle(libraryKeys, hit) {
  if (!libraryKeys?.size) return false;
  if (hit.tmdbId != null && hit.mediaType) {
    if (libraryKeys.has(`tmdb:${hit.mediaType}:${hit.tmdbId}`)) return true;
  }
  for (const k of hit.keys || []) {
    if (libraryKeys.has(k)) return true;
  }
  return false;
}

export async function runMatch(ctx, { preview = false, forceFilmography = false } = {}) {
  const settings = ctx.settings.get();
  const windowDays = Math.max(1, Number(settings.notifyWindowDays || 7));
  const typeOpts = {
    matchMovies: settings.matchMovies !== false,
    matchTv: settings.matchTv !== false,
  };
  const preferredRegion = await resolvePreferredRegion(ctx, settings);
  const dvrTitles = await loadDvrChannelTitles(ctx);
  const restrictToDvr =
    settings.restrictToDvrChannels !== false && dvrTitles.length > 0;
  const excludedChannels = resolveExcludedChannels(settings.excludedChannels);

  let airings = await fetchUpcomingAirings(settings.epgUrl, windowDays, {
    preferredRegion,
  });
  airings = filterAiringsByLocation(airings, {
    excludedChannels,
    restrictToDvr,
    dvrChannelTitles: dvrTitles,
  });

  const watchlistItems = getWatchlistItems(ctx);
  const library = getLibraryKeySet(ctx);
  const tracked = getTrackedPeople(ctx);
  const trackedWithIds = tracked.filter((p) => Number(p.tmdbPersonId) > 0);
  const sent = new Set(ctx.storage.get(SENT_KEY) || []);

  let filmography = { entries: [], people: 0, fetched: 0 };
  if (trackedWithIds.length > 0) {
    filmography = await loadFilmographyIndex(ctx, { force: forceFilmography });
  }

  const matches = [];
  let resolved = 0;
  let unresolved = 0;
  let watchlistHits = 0;
  let personHits = 0;
  let skippedType = 0;
  let skippedLibrary = 0;

  for (const airing of airings) {
    if (!airingAllowedBySettings(airing, typeOpts)) {
      skippedType += 1;
      continue;
    }

    const wlHit = findWatchlistHit(airing, watchlistItems, typeOpts);
    if (wlHit) {
      if (!mediaTypeAllowed(wlHit.mediaType, typeOpts)) {
        skippedType += 1;
        continue;
      }
      if (libraryHasTitle(library, wlHit)) {
        skippedLibrary += 1;
        continue;
      }
      resolved += 1;
      watchlistHits += 1;
      const notifyKey = notifyKeyFor(wlHit, airing);
      matches.push({
        airing,
        title: wlHit,
        reason: 'watchlist',
        personName: null,
        notifyKey,
        alreadyNotified: sent.has(notifyKey),
      });
      continue;
    }

    if (filmography.entries.length === 0) {
      unresolved += 1;
      continue;
    }

    const hit = findFilmographyHit(airing, filmography.entries, typeOpts);
    if (!hit) {
      unresolved += 1;
      continue;
    }

    const title = {
      title: hit.title,
      year: hit.year,
      mediaType: hit.mediaType,
      tmdbId: hit.tmdbId,
      keys: hit.tmdbId != null ? [`tmdb:${hit.mediaType}:${hit.tmdbId}`] : [],
    };

    if (libraryHasTitle(library, title)) {
      skippedLibrary += 1;
      continue;
    }

    resolved += 1;
    personHits += 1;
    const notifyKey = notifyKeyFor(title, airing);
    matches.push({
      airing,
      title,
      reason: 'tracked_person',
      personName: hit.personName,
      notifyKey,
      alreadyNotified: sent.has(notifyKey),
    });
  }

  const deduped = dedupeMatchesByTitle(matches);

  let recorded = 0;
  let recordSkipped = 0;
  let recordErrors = [];
  if (!preview && settings.autoRecord) {
    const rec = await scheduleRecordings(ctx, deduped, settings);
    recorded = rec.recorded;
    recordSkipped = rec.skipped;
    recordErrors = rec.errors;
  }

  const result = {
    ranAt: new Date().toISOString(),
    airings: airings.length,
    resolved,
    unresolved,
    skippedType,
    skippedLibrary,
    watchlistHits,
    personHits,
    filmographyPeople: filmography.people,
    filmographyFetched: filmography.fetched,
    preferredRegion,
    recorded,
    recordSkipped,
    recordErrors: recordErrors.slice(0, 5),
    matchCount: deduped.length,
    rawMatchCount: matches.length,
    watchlistCount: watchlistItems.length,
    matches: deduped.slice(0, 100),
  };

  if (!preview) {
    const pending = ctx.storage.get(DIGEST_KEY) || [];
    const pendingKeys = new Set(pending.map((m) => m.notifyKey));
    for (const match of deduped) {
      if (match.alreadyNotified || pendingKeys.has(match.notifyKey)) continue;
      pending.push({
        notifyKey: match.notifyKey,
        reason: match.reason,
        personName: match.personName,
        title: match.title.title,
        year: match.title.year,
        mediaType: match.title.mediaType,
        channel: match.airing.channel,
        alsoOn: match.airing.alsoOn || [],
        startsAt: match.airing.startsAt,
        rawTitle: match.airing.rawTitle,
      });
      pendingKeys.add(match.notifyKey);
    }
    ctx.storage.set(DIGEST_KEY, pending);
    ctx.storage.set(LAST_MATCH_KEY, {
      ...result,
      matches: result.matches.map((m) => ({
        notifyKey: m.notifyKey,
        reason: m.reason,
        personName: m.personName,
        title: m.title.title,
        mediaType: m.title.mediaType || m.airing.mediaTypeHint || null,
        channel: m.airing.channel,
        alsoOn: m.airing.alsoOn || [],
        startsAt: m.airing.startsAt,
        alreadyNotified: m.alreadyNotified,
      })),
    });
  }

  return result;
}

async function resolvePreferredRegion(ctx, settings) {
  const configured = String(settings.preferredRegion || '').trim();
  if (configured) return configured;
  if (!ctx.plex?.getDvrChannels) return null;
  try {
    const channels = await ctx.plex.getDvrChannels();
    return derivePreferredRegion((channels || []).map((c) => c.title));
  } catch (err) {
    ctx.log?.warn?.(`Could not derive preferred region from DVR: ${err.message}`);
    return null;
  }
}

async function loadDvrChannelTitles(ctx) {
  if (!ctx.plex?.getDvrChannels) return [];
  try {
    const channels = await ctx.plex.getDvrChannels();
    return (channels || [])
      .map((c) => String(c.title || c.name || '').trim())
      .filter(Boolean);
  } catch (err) {
    ctx.log?.warn?.(`Could not load DVR channels for EPG filter: ${err.message}`);
    return [];
  }
}

function recordLibrarySectionId(settings) {
  const libs = settings.recordLibrary;
  if (Array.isArray(libs) && libs.length > 0) {
    return String(libs[0]);
  }
  if (libs != null && libs !== '') return String(libs);
  const fallback = settings.libraries;
  if (Array.isArray(fallback) && fallback.length > 0) return String(fallback[0]);
  return null;
}

/**
 * Schedule one-shot Plex DVR recordings for matched movies.
 * Uses Plex subscription templates when a Plex/Discover guid is available;
 * falls back to title+year with the DVR mediaProviderID (never tmdb:// guids).
 */
export async function scheduleRecordings(ctx, matches, settings) {
  const sectionId = recordLibrarySectionId(settings);
  if (!sectionId) {
    return {
      recorded: 0,
      skipped: 0,
      errors: ['No record library configured (set DVR record library in settings)'],
    };
  }
  if (!ctx.plex?.createSubscription) {
    return {
      recorded: 0,
      skipped: 0,
      errors: ['Plex DVR API not available'],
    };
  }

  let mediaProviderID = null;
  try {
    mediaProviderID = ctx.plex.getDvrMediaProviderId
      ? await ctx.plex.getDvrMediaProviderId()
      : null;
  } catch (err) {
    ctx.log?.warn?.(`Could not resolve DVR media provider: ${err.message}`);
  }

  try {
    const libs = await ctx.plex.getLibraries();
    const section = (libs || []).find((l) => String(l.id) === String(sectionId));
    if (section && String(section.type || '').toLowerCase() !== 'movie') {
      return {
        recorded: 0,
        skipped: 0,
        errors: [
          `Record library must be a movie library (section ${sectionId} is "${section.type}")`,
        ],
      };
    }
  } catch (err) {
    ctx.log?.warn?.(`Could not verify record library type: ${err.message}`);
  }

  const recordedKeys = new Set(ctx.storage.get(RECORDED_KEY) || []);
  let existingTitles = new Set();
  try {
    const subs = await ctx.plex.getSubscriptions();
    existingTitles = new Set(
      (subs || []).map((s) => normalizeTitle(s.title || '')).filter(Boolean),
    );
  } catch (err) {
    ctx.log?.warn?.(`Could not list subscriptions: ${err.message}`);
  }

  let recorded = 0;
  let skipped = 0;
  const errors = [];

  for (const match of matches || []) {
    const mediaType = normalizeMediaType(match.title?.mediaType);
    if (mediaType !== 'movie') {
      skipped += 1;
      continue;
    }
    const notifyKey = match.notifyKey;
    if (!notifyKey || recordedKeys.has(notifyKey)) {
      skipped += 1;
      continue;
    }
    const title = match.title?.title;
    if (!title) {
      skipped += 1;
      continue;
    }
    if (existingTitles.has(normalizeTitle(title))) {
      recordedKeys.add(notifyKey);
      skipped += 1;
      continue;
    }

    try {
      await scheduleOneMovieRecording(ctx, {
        match,
        sectionId,
        mediaProviderID,
      });
      recordedKeys.add(notifyKey);
      existingTitles.add(normalizeTitle(title));
      recorded += 1;
      ctx.log?.info?.(`Scheduled DVR recording: ${title}`);
    } catch (err) {
      const msg = err.message || String(err);
      errors.push(`${title}: ${msg}`);
      ctx.log?.warn?.(`DVR schedule failed for ${title}: ${msg}`);
    }
  }

  ctx.storage.set(RECORDED_KEY, [...recordedKeys]);
  return { recorded, skipped, errors };
}

/**
 * @param {any} ctx
 * @param {{ match: any, sectionId: string, mediaProviderID: string|null }} opts
 */
async function scheduleOneMovieRecording(ctx, { match, sectionId, mediaProviderID }) {
  const title = match.title.title;
  const year = match.title.year != null ? Number(match.title.year) : null;
  const plexGuid = await resolvePlexMovieGuid(ctx, match);

  if (plexGuid && ctx.plex.getSubscriptionTemplates) {
    try {
      const templates = await ctx.plex.getSubscriptionTemplates(plexGuid);
      const oneShot =
        templates.find((t) => /this (movie|airing|episode)/i.test(t.title || '')) ||
        templates.find((t) => t.selected) ||
        templates[0];
      if (oneShot?.parameters && ctx.plex.createSubscriptionFromTemplate) {
        return ctx.plex.createSubscriptionFromTemplate(oneShot.parameters, {
          targetLibrarySectionID: Number(sectionId),
          prefs: { oneShot: 1 },
        });
      }
    } catch (err) {
      ctx.log?.warn?.(
        `Subscription template failed for ${title} (${plexGuid}): ${err.message}`,
      );
    }
  }

  const hints = {
    title,
    type: 1,
  };
  if (year) hints.year = year;
  // Only pass Plex/EPG guids — tmdb:// causes PMS 400 Bad Request
  if (plexGuid) {
    hints.guid = plexGuid;
  }

  const params = {
    libraryType: 1,
  };
  if (mediaProviderID) params.mediaProviderID = mediaProviderID;
  if (match.airing?.startsAt) {
    const ts = Math.floor(new Date(match.airing.startsAt).getTime() / 1000);
    if (Number.isFinite(ts) && ts > 0) {
      params.airingTimes = String(ts);
    }
  }

  return ctx.plex.createSubscription({
    type: 1,
    targetLibrarySectionID: Number(sectionId),
    hints,
    prefs: { oneShot: 1 },
    params,
  });
}

/**
 * Prefer a Plex Discover guid for DVR matching (never tmdb://).
 */
async function resolvePlexMovieGuid(ctx, match) {
  const fromTitle = Array.isArray(match.title?.guids) ? match.title.guids : [];
  const plexGuid = fromTitle.find(
    (g) => typeof g === 'string' && /^plex:\/\//i.test(g),
  );
  if (plexGuid) return plexGuid;

  if (!ctx.plex?.searchDiscover) return null;
  const year = match.title?.year;
  const query =
    year != null ? `${match.title.title} ${year}` : match.title.title;
  try {
    const results = await ctx.plex.searchDiscover(query, { limit: 10 });
    const movies = (results || []).filter((r) => r.type === 'movie');
    const want = String(match.title.title || '')
      .trim()
      .toLowerCase();
    const hit =
      movies.find(
        (r) =>
          String(r.title || '')
            .trim()
            .toLowerCase() === want &&
          (year == null || Number(r.year) === Number(year)),
      ) ||
      movies.find(
        (r) =>
          String(r.title || '')
            .trim()
            .toLowerCase() === want,
      ) ||
      movies[0];
    if (!hit) return null;
    const guids = Array.isArray(hit.guids) ? hit.guids : [];
    const g = guids.find((x) => typeof x === 'string' && /^plex:\/\//i.test(x));
    if (g) return g;
    if (hit.guid && /^plex:\/\//i.test(hit.guid)) return hit.guid;
    if (hit.ratingKey) return `plex://movie/${hit.ratingKey}`;
  } catch (err) {
    ctx.log?.warn?.(
      `Discover lookup for DVR failed (${match.title?.title}): ${err.message}`,
    );
  }
  return null;
}

/**
 * Keep earliest airing per notifyKey; merge alsoOn / channel lists.
 */
export function dedupeMatchesByTitle(matches) {
  const byKey = new Map();
  for (const match of matches) {
    const key = match.notifyKey;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...match,
        airing: {
          ...match.airing,
          alsoOn: [...(match.airing.alsoOn || [])],
          channels: [...(match.airing.channels || [])],
        },
      });
      continue;
    }

    const exStart = Date.parse(existing.airing.startsAt) || 0;
    const nextStart = Date.parse(match.airing.startsAt) || 0;

    for (const ch of match.airing.channels || []) {
      if (!existing.airing.channels.some((c) => c.name === ch.name)) {
        existing.airing.channels.push(ch);
      }
    }
    for (const name of match.airing.alsoOn || []) {
      if (!existing.airing.alsoOn.includes(name)) {
        existing.airing.alsoOn.push(name);
      }
    }
    if (
      match.airing.channel &&
      match.airing.channel !== existing.airing.channel &&
      !existing.airing.alsoOn.includes(match.airing.channel)
    ) {
      existing.airing.alsoOn.push(match.airing.channel);
    }

    if (nextStart < exStart) {
      const prevChannel = existing.airing.channel;
      existing.airing = {
        ...match.airing,
        channels: existing.airing.channels,
        alsoOn: existing.airing.alsoOn,
      };
      if (
        prevChannel &&
        prevChannel !== existing.airing.channel &&
        !existing.airing.alsoOn.includes(prevChannel)
      ) {
        existing.airing.alsoOn.push(prevChannel);
      }
      existing.reason = match.reason;
      existing.personName = match.personName ?? existing.personName;
      existing.title = match.title;
      existing.alreadyNotified =
        existing.alreadyNotified || match.alreadyNotified;
    } else if (match.reason === 'tracked_person' && !existing.personName) {
      existing.personName = match.personName;
    }
  }

  return [...byKey.values()].sort((a, b) =>
    String(a.airing.startsAt).localeCompare(String(b.airing.startsAt)),
  );
}

function notifyKeyFor(title, airing) {
  if (title.tmdbId != null) {
    return `tmdb:${title.mediaType || 'movie'}:${title.tmdbId}`;
  }
  if (title.imdbId) return `imdb:${title.imdbId}`;
  if (title.keys?.[0]) return title.keys[0];
  return `${airing.titleNormalized}|${airing.parsedYear || ''}`;
}

export async function sendDigest(ctx) {
  const pending = ctx.storage.get(DIGEST_KEY) || [];
  if (pending.length === 0) {
    return { sent: 0, message: 'No pending digest items' };
  }

  const settings = ctx.settings.get();
  if (!settings.smtpHost || !settings.smtpTo || !settings.smtpFrom) {
    throw new Error('Configure SMTP host, from, and to addresses in settings');
  }

  const count = pending.length;
  const subject =
    count === 1
      ? '1 upcoming title on Freeview'
      : `${count} upcoming titles on Freeview`;

  const lines = pending.map((item) => {
    const when = item.startsAt ? new Date(item.startsAt).toUTCString() : '';
    const also =
      item.alsoOn?.length > 0 ? ` (also ${item.alsoOn.join(', ')})` : '';
    const reason =
      item.reason === 'watchlist'
        ? 'Watchlist'
        : item.personName
          ? `Tracked: ${item.personName}`
          : 'Tracked person';
    return `• ${item.title}${item.year ? ` (${item.year})` : ''} — ${item.channel || ''}${also} ${when} [${reason}]`;
  });

  const text = `Upcoming Freeview matches:\n\n${lines.join('\n')}\n`;
  const html = `<p>Upcoming Freeview matches:</p><ul>${pending
    .map((item) => {
      const when = item.startsAt ? new Date(item.startsAt).toUTCString() : '';
      const also =
        item.alsoOn?.length > 0
          ? ` <span style="opacity:.7">(also ${escapeHtml(item.alsoOn.join(', '))})</span>`
          : '';
      const reason =
        item.reason === 'watchlist'
          ? 'Watchlist'
          : item.personName
            ? `Tracked: ${escapeHtml(item.personName)}`
            : 'Tracked person';
      return `<li><strong>${escapeHtml(item.title)}</strong>${
        item.year ? ` (${item.year})` : ''
      } — ${escapeHtml(item.channel || '')}${also} ${escapeHtml(when)} <em>${reason}</em></li>`;
    })
    .join('')}</ul>`;

  await ctx.mail.send({ subject, text, html });

  const sent = new Set(ctx.storage.get(SENT_KEY) || []);
  for (const item of pending) sent.add(item.notifyKey);
  ctx.storage.set(SENT_KEY, [...sent]);
  ctx.storage.set(DIGEST_KEY, []);

  return { sent: count, message: `Sent digest with ${count} title(s)` };
}

export function getPendingDigest(ctx) {
  return ctx.storage.get(DIGEST_KEY) || [];
}

export function getLastMatch(ctx) {
  return ctx.storage.get(LAST_MATCH_KEY) || null;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
