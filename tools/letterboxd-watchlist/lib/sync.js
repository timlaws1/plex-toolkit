import {
  isCloudflareChallenge,
  nextWatchlistPage,
  parseWatchlistHtml,
  parseWatchlistRss,
  watchlistPageUrl,
} from './rss.js';

const MAX_WATCHLIST_PAGES = 50;

/**
 * Sync a public Letterboxd watchlist into the Plex account watchlist.
 * @param {any} ctx
 * @param {{ fetchRss?: typeof fetch }} [opts]
 */
export async function runSync(ctx, opts = {}) {
  const settings = ctx.settings.get();
  const username = String(settings.letterboxdUsername || '').trim();
  if (!username) {
    return {
      ok: false,
      message: 'Set a Letterboxd username in settings first.',
      added: 0,
      skipped: 0,
      unmatched: 0,
    };
  }

  const fetchFn = opts.fetchRss || ctx.fetch?.bind(ctx);
  if (typeof fetchFn !== 'function') {
    throw new Error('Letterboxd sync cannot fetch the watchlist');
  }
  const items = await loadWatchlist(username, fetchFn);
  if (items.length === 0) {
    const result = {
      ok: true,
      message: 'Letterboxd watchlist is empty or could not be parsed.',
      added: 0,
      skipped: 0,
      unmatched: 0,
      total: 0,
    };
    ctx.storage.set('lastSync', { ...result, at: new Date().toISOString() });
    return result;
  }

  const watchlist = await ctx.plex.getWatchlist();
  const onWatchlist = buildWatchlistIndex(watchlist);

  let added = 0;
  let skipped = 0;
  let unmatched = 0;
  const addedTitles = [];
  const unmatchedTitles = [];

  for (const item of items) {
    if (isAlreadyOnWatchlist(item, onWatchlist)) {
      skipped += 1;
      continue;
    }

    const match = await findDiscoverMatch(ctx, item);
    if (!match?.ratingKey) {
      unmatched += 1;
      unmatchedTitles.push(item.titleRaw || item.title);
      continue;
    }

    if (onWatchlist.byRatingKey.has(String(match.ratingKey))) {
      skipped += 1;
      continue;
    }

    await ctx.plex.addToWatchlist(match.ratingKey);
    onWatchlist.byRatingKey.add(String(match.ratingKey));
    rememberTitle(onWatchlist, match.title, match.year);
    added += 1;
    addedTitles.push(match.title || item.title);
  }

  const result = {
    ok: true,
    message: `Synced ${items.length} Letterboxd titles: ${added} added, ${skipped} already on Plex, ${unmatched} unmatched.`,
    added,
    skipped,
    unmatched,
    total: items.length,
    addedTitles,
    unmatchedTitles: unmatchedTitles.slice(0, 20),
  };
  ctx.storage.set('lastSync', { ...result, at: new Date().toISOString() });
  return result;
}

async function loadWatchlist(username, fetchFn) {
  const firstUrl = watchlistPageUrl(username);
  const first = await fetchFn(firstUrl);
  const body = await first.text();
  if (first.ok && looksLikeRss(body)) {
    return parseWatchlistRss(body);
  }

  assertWatchlistPage(first.status, body);
  const items = [];
  const seen = new Set();
  collectPage(items, seen, body);

  let next = nextWatchlistPage(body);
  const visited = new Set([firstUrl]);
  for (let page = 0; next && page < MAX_WATCHLIST_PAGES; page += 1) {
    const url = new URL(next, 'https://letterboxd.com').href;
    if (visited.has(url)) break;
    visited.add(url);
    const res = await fetchFn(url);
    const html = await res.text();
    if (res.ok && looksLikeRss(html)) {
      collectRss(items, seen, html);
      break;
    }
    assertWatchlistPage(res.status, html);
    const before = items.length;
    collectPage(items, seen, html);
    if (items.length === before) break;
    next = nextWatchlistPage(html);
  }
  return items;
}

function looksLikeRss(body) {
  return /<rss[\s>]|<item\b/i.test(String(body || '').slice(0, 800));
}

function collectRss(items, seen, xml) {
  for (const item of parseWatchlistRss(xml)) {
    const key = item.guid || item.link || item.titleRaw;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
}

function collectPage(items, seen, html) {
  for (const item of parseWatchlistHtml(html)) {
    const key = item.link || item.titleRaw;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
}

function assertWatchlistPage(status, html) {
  if (isCloudflareChallenge(html)) {
    throw new Error('Letterboxd blocked the request. Try the sync again in a few minutes.');
  }
  if (status === 404) {
    throw new Error('Letterboxd user not found. Check the username and that the watchlist is public.');
  }
  if (status === 403 || /letterboxd - forbidden/i.test(String(html).slice(0, 2500))) {
    throw new Error('Letterboxd watchlist is private or unavailable.');
  }
  if (status && status >= 400) {
    throw new Error(`Letterboxd watchlist failed: HTTP ${status}`);
  }
}

function buildWatchlistIndex(watchlist) {
  const byRatingKey = new Set();
  const byTitleYear = new Set();
  for (const row of watchlist || []) {
    if (row?.ratingKey) byRatingKey.add(String(row.ratingKey));
    rememberTitle(
      { byTitleYear },
      row?.title,
      row?.year != null ? Number(row.year) : null,
    );
  }
  return { byRatingKey, byTitleYear };
}

function rememberTitle(index, title, year) {
  const key = titleKey(title, year);
  if (key) index.byTitleYear.add(key);
}

function titleKey(title, year) {
  const t = String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!t) return null;
  if (year != null && Number.isFinite(Number(year))) {
    return `${t}|${Number(year)}`;
  }
  return `${t}|`;
}

function isAlreadyOnWatchlist(item, index) {
  return index.byTitleYear.has(titleKey(item.title, item.year));
}

async function findDiscoverMatch(ctx, item) {
  const query =
    item.year != null ? `${item.title} ${item.year}` : item.title;
  const results = await ctx.plex.searchDiscover(query, { limit: 10 });
  const movies = (results || []).filter((r) => r.type === 'movie');
  if (movies.length === 0) return null;

  const want = String(item.title || '')
    .trim()
    .toLowerCase();
  const exactYear = movies.find(
    (r) =>
      String(r.title || '')
        .trim()
        .toLowerCase() === want &&
      item.year != null &&
      Number(r.year) === Number(item.year),
  );
  if (exactYear) return exactYear;

  const exactTitle = movies.find(
    (r) =>
      String(r.title || '')
        .trim()
        .toLowerCase() === want,
  );
  if (exactTitle) return exactTitle;

  if (item.year != null) {
    const yearHit = movies.find((r) => Number(r.year) === Number(item.year));
    if (yearHit) return yearHit;
  }

  return movies[0] || null;
}
