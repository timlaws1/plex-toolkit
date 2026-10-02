import { loadList, parseListUrl } from './lib/letterboxd.js';
import { buildIndex, loadMovies, matchFilm, movieSectionIds } from './lib/library.js';
import { buildMissingEmail } from './lib/mail.js';
import { filmKey, matchList, missingSignature, planCollection } from './lib/sync.js';
import { renderHome } from './lib/ui.js';

const APP = '/plugins/letterboxd-lists/app';
const HOUR_MS = 60 * 60 * 1000;
const REPORT_LIMIT = 500;

let busy = false;

export async function activate(ctx) {
  const settings = ctx.settings.get();
  if (configuredLists(settings).length) {
    void runScheduledSync(ctx);
    const hours = Math.max(1, Number(settings.intervalHours) || 24);
    ctx.scheduler.every(hours * HOUR_MS, () => runScheduledSync(ctx), 'letterboxd-lists-sync');
  }
  refreshPanel(ctx);
  ctx.log.info('Letterboxd Lists activated');
}

export async function deactivate(ctx) {
  ctx.log.info('Letterboxd Lists deactivated');
}

export async function handleRequest(ctx, req) {
  if (req.method === 'POST') {
    if (req.body?.action !== 'sync') throw new Error('Unknown action');
    const message = await withLock(() => syncAll(ctx));
    refreshPanel(ctx);
    return { redirect: APP, message };
  }
  const settings = ctx.settings.get();
  const libraryNames = new Map();
  if (ctx.plex.isConfigured()) {
    try {
      for (const lib of await ctx.plex.getLibraries()) libraryNames.set(String(lib.id), lib.title);
    } catch (err) {
      ctx.log.warn(`Could not list Plex libraries: ${err.message}`);
    }
  }
  const state = ctx.storage.get('lists') || {};
  const lists = configuredLists(settings).map((entry) => ({
    url: entry.url,
    error: entry.error,
    state: entry.url ? state[entry.url] : null,
  }));
  return {
    title: 'Letterboxd Lists',
    body: renderHome({
      lists,
      libraryNames,
      hasLibraries: (settings.libraries || []).length > 0,
      lastRun: ctx.storage.get('lastRun'),
    }),
  };
}

function configuredLists(settings) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(settings.lists) ? settings.lists : []) {
    try {
      const { url } = parseListUrl(raw);
      if (seen.has(url)) continue;
      seen.add(url);
      out.push({ url, error: null });
    } catch (err) {
      out.push({ url: String(raw), error: err.message });
    }
  }
  return out;
}

async function runScheduledSync(ctx) {
  try {
    await withLock(() => syncAll(ctx));
  } catch (err) {
    ctx.log.error(`Letterboxd list sync failed: ${err.message}`);
    saveRun(ctx, `Failed: ${err.message}`);
  }
  refreshPanel(ctx);
}

async function syncAll(ctx) {
  const settings = ctx.settings.get();
  const lists = configuredLists(settings);
  if (!lists.length) throw new Error('Add at least one Letterboxd list URL in tool settings.');
  const sectionIds = await movieSectionIds(ctx.plex, settings.libraries);
  if (!sectionIds.length) throw new Error('Choose at least one movie library in tool settings first.');

  const sections = [];
  for (const sectionId of sectionIds) {
    sections.push({ sectionId, index: buildIndex(await loadMovies(ctx.plex, [sectionId])) });
  }

  const previous = ctx.storage.get('lists') || {};
  const next = {};
  const changed = [];
  const watchlist = settings.addMissingToWatchlist ? await watchlistContext(ctx) : null;
  let failures = 0;

  for (const entry of lists) {
    if (entry.error) {
      failures += 1;
      continue;
    }
    const prev = previous[entry.url] || {};
    try {
      const { title, films } = await loadList(entry.url, (url) => ctx.fetch(url));
      if (!films.length) throw new Error('The list is empty or could not be read');
      const result = matchList(films, sections);

      const collections = { ...(prev.collections || {}) };
      for (const { sectionId } of sections) {
        collections[sectionId] = await syncCollection(ctx, {
          sectionId,
          title,
          matched: [...result.keysBySection.get(sectionId)],
          saved: collections[sectionId],
        });
      }

      const watchlistAdded = watchlist ? await addMissingToWatchlist(ctx, watchlist, result.missing) : 0;
      const signature = missingSignature(result.missing);
      if (signature !== prev.missingSignature) {
        changed.push({ title, url: entry.url, owned: result.owned, total: films.length, missing: result.missing });
      }

      next[entry.url] = {
        title,
        total: films.length,
        owned: result.owned,
        missing: result.missing.slice(0, REPORT_LIMIT),
        missingCount: result.missing.length,
        ambiguous: result.ambiguous.slice(0, REPORT_LIMIT),
        ambiguousCount: result.ambiguous.length,
        missingSignature: signature,
        collections,
        watchlistAdded,
        syncedAt: new Date().toISOString(),
        error: null,
      };
    } catch (err) {
      failures += 1;
      ctx.log.warn(`Letterboxd list ${entry.url} failed: ${err.message}`);
      next[entry.url] = { ...prev, error: err.message, syncedAt: new Date().toISOString() };
    }
  }
  ctx.storage.set('lists', next);
  if (watchlist) ctx.storage.set('watchlistHandled', [...watchlist.handled]);

  if (changed.length && settings.emailMissing) await sendMissingEmail(ctx, settings, changed);

  const synced = lists.length - failures;
  const message = `Synced ${synced} of ${lists.length} list${lists.length === 1 ? '' : 's'}${failures ? ` (${failures} failed, see the tool page)` : ''}`;
  ctx.log.info(message);
  saveRun(ctx, message);
  return message;
}

async function syncCollection(ctx, { sectionId, title, matched, saved }) {
  let key = saved?.key || null;
  let managed = saved?.managed || [];
  let current = null;
  if (key) {
    try {
      current = await collectionKeys(ctx, key);
    } catch {
      key = null;
      managed = [];
    }
  }
  if (!key) {
    const existing = (await ctx.plex.listCollections(sectionId)).find((c) => c.title === title);
    if (existing) {
      key = existing.ratingKey;
      current = await collectionKeys(ctx, key);
    }
  }
  if (!key) {
    if (!matched.length) return null;
    const created = await ctx.plex.createCollection({ sectionId, title, ratingKeys: matched });
    return { key: created.ratingKey, managed: matched };
  }
  const plan = planCollection({ matched, managed, current });
  if (plan.add.length) await ctx.plex.addCollectionItems(key, plan.add);
  for (const ratingKey of plan.remove) await ctx.plex.removeCollectionItem(key, ratingKey);
  return { key, managed: plan.managed };
}

async function collectionKeys(ctx, key) {
  return (await ctx.plex.getCollectionItems(key)).map((item) => String(item.ratingKey));
}

async function watchlistContext(ctx) {
  const entries = (await ctx.plex.getWatchlist()).filter((entry) => entry?.type === 'movie');
  return {
    entries,
    index: buildIndex(entries),
    handled: new Set(ctx.storage.get('watchlistHandled') || []),
  };
}

async function addMissingToWatchlist(ctx, watchlist, missing) {
  let added = 0;
  for (const film of missing) {
    const key = filmKey(film);
    if (watchlist.handled.has(key)) continue;
    if (matchFilm(watchlist.index, film).status !== 'missing') {
      watchlist.handled.add(key);
      continue;
    }
    const query = film.year ? `${film.title} ${film.year}` : film.title;
    const results = (await ctx.plex.searchDiscover(query, { limit: 10 })).filter((r) => r.type === 'movie');
    const match = matchFilm(buildIndex(results), film);
    if (match.status !== 'matched') {
      watchlist.handled.add(key);
      ctx.log.info(`No single Discover match for ${film.title}${film.year ? ` (${film.year})` : ''}; not added to the watchlist`);
      continue;
    }
    const pick = match.items[0];
    await ctx.plex.addToWatchlist(pick.ratingKey);
    watchlist.handled.add(key);
    watchlist.entries.push(pick);
    watchlist.index = buildIndex(watchlist.entries);
    added += 1;
  }
  return added;
}

async function sendMissingEmail(ctx, settings, changed) {
  if (!ctx.mail.isConfigured()) {
    ctx.log.warn('Missing-film email skipped: set up a mail server on the Mail page');
    return;
  }
  const { subject, text, html } = buildMissingEmail(changed);
  try {
    await ctx.mail.send({ to: String(settings.emailTo || '').trim() || undefined, subject, text, html });
  } catch (err) {
    ctx.log.error(`Missing-film email failed: ${err.message}`);
  }
}

function saveRun(ctx, message) {
  ctx.storage.set('lastRun', { at: new Date().toISOString(), message });
}

async function withLock(fn) {
  if (busy) throw new Error('A list sync is already running. Try again in a moment.');
  busy = true;
  try {
    return await fn();
  } finally {
    busy = false;
  }
}

function refreshPanel(ctx) {
  const settings = ctx.settings.get();
  const last = ctx.storage.get('lastRun');
  const state = ctx.storage.get('lists') || {};
  const items = [
    {
      id: 'sync',
      title: 'List sync',
      subtitle: last?.message || 'Not synced yet',
      meta: last?.at ? `Last run: ${last.at}` : '',
      actions: [{ id: 'syncNow', label: 'Sync now' }],
    },
  ];
  for (const entry of configuredLists(settings)) {
    const row = entry.url ? state[entry.url] : null;
    items.push({
      id: entry.url,
      title: row?.title || entry.url,
      subtitle: entry.error
        || row?.error
        || (row ? `${row.owned} of ${row.total} in your libraries · ${row.missingCount} missing` : 'Not synced yet'),
      meta: row?.syncedAt ? `Synced: ${row.syncedAt}` : '',
      actions: [],
    });
  }
  ctx.panels.add({
    title: 'Letterboxd Lists',
    empty: 'Add list URLs in settings',
    items,
    actions: {
      async syncNow() {
        const message = await withLock(() => syncAll(ctx));
        refreshPanel(ctx);
        return { message };
      },
    },
  });
}

export const _internal = { syncAll, syncCollection };
