import { identityKeys } from './guids.js';
import { normalizePersonName, normalizeTitle } from './normalize.js';

const HISTORY_KEY = 'historyIndex';
const LIBRARY_KEY = 'libraryKeys';
const WATCHLIST_KEY = 'watchlistKeys';
const WATCHLIST_ITEMS_KEY = 'watchlistItems';

/**
 * Scan selected libraries and build people rankings from watched titles.
 */
export async function refreshHistory(ctx) {
  const settings = ctx.settings.get();
  const libraryIds = Array.isArray(settings.libraries) ? settings.libraries : [];
  if (libraryIds.length === 0) {
    const empty = emptyIndex();
    ctx.storage.set(HISTORY_KEY, empty);
    ctx.storage.set(LIBRARY_KEY, []);
    return empty;
  }

  const libraries = await ctx.plex.getLibraries();
  const byId = new Map(libraries.map((l) => [String(l.id), l]));

  const people = {
    actors: new Map(),
    directors: new Map(),
    writers: new Map(),
    genres: new Map(),
  };
  const libraryKeys = new Set();
  let moviesScanned = 0;
  let showsScanned = 0;
  let watchedMovies = 0;
  let watchedShows = 0;

  for (const libId of libraryIds.map(String)) {
    const lib = byId.get(libId);
    if (!lib) continue;

    if (lib.type === 'movie') {
      const items = await fetchAllLibraryItems(ctx, libId, 1);
      moviesScanned += items.length;
      for (const item of items) {
        addLibraryKeys(libraryKeys, item);
        const weight = Number(item.viewCount || 0);
        if (weight <= 0) continue;
        watchedMovies += 1;

        let credits = item;
        if (
          (!item.roles || item.roles.length === 0) &&
          (!item.directors || item.directors.length === 0)
        ) {
          try {
            const meta = await ctx.plex.getMetadata(item.ratingKey);
            if (meta) credits = { ...item, ...meta };
          } catch {
            // keep list fields
          }
        }

        accumulateCredits(people, credits, weight, {
          ratingKey: item.ratingKey,
          title: item.title,
          year: item.year,
          type: 'movie',
        });
      }
    } else if (lib.type === 'show') {
      const shows = await fetchAllLibraryItems(ctx, libId, 2);
      showsScanned += shows.length;
      for (const show of shows) {
        addLibraryKeys(libraryKeys, show);

        let weight = 0;
        try {
          const episodes = await ctx.plex.getEpisodes(show.ratingKey);
          weight = episodes.reduce((sum, ep) => sum + Number(ep.viewCount || 0), 0);
        } catch (err) {
          ctx.log.warn(
            `Failed to load episodes for ${show.title}: ${err.message}`,
          );
          weight = Number(show.viewedLeafCount || 0);
        }

        if (weight <= 0) continue;
        watchedShows += 1;

        let credits = show;
        if (
          (!show.roles || show.roles.length === 0) &&
          (!show.directors || show.directors.length === 0)
        ) {
          try {
            const meta = await ctx.plex.getMetadata(show.ratingKey);
            if (meta) credits = { ...show, ...meta };
          } catch {
            // keep list fields
          }
        }

        accumulateCredits(people, credits, weight, {
          ratingKey: show.ratingKey,
          title: show.title,
          year: show.year,
          type: 'show',
        });
      }
    }
  }

  const index = {
    updatedAt: new Date().toISOString(),
    stats: {
      moviesScanned,
      showsScanned,
      watchedMovies,
      watchedShows,
    },
    actors: rankMap(people.actors),
    directors: rankMap(people.directors),
    writers: rankMap(people.writers),
    genres: rankMap(people.genres),
  };

  ctx.storage.set(HISTORY_KEY, index);
  ctx.storage.set(LIBRARY_KEY, [...libraryKeys]);
  return index;
}

export async function refreshWatchlist(ctx) {
  const items = await ctx.plex.getWatchlist();
  const keys = new Set();
  const entries = [];
  for (const item of items) {
    addLibraryKeys(keys, item);
    const identity = identityKeys(item);
    entries.push({
      title: item.title || null,
      titleNormalized: normalizeTitle(item.title || ''),
      year: item.year ?? null,
      type: item.type === 'show' ? 'tv' : item.type || null,
      keys: identity.keys,
      tmdbId: identity.tmdbId,
      imdbId: identity.imdbId,
      guids: item.guids || [],
    });
  }
  const list = [...keys];
  ctx.storage.set(WATCHLIST_KEY, list);
  ctx.storage.set(WATCHLIST_ITEMS_KEY, entries);
  return { count: items.length, keys: list, items: entries };
}

export function getWatchlistItems(ctx) {
  const items = ctx.storage.get(WATCHLIST_ITEMS_KEY);
  return Array.isArray(items) ? items : [];
}

export function getHistoryIndex(ctx) {
  return ctx.storage.get(HISTORY_KEY) || emptyIndex();
}

export function getLibraryKeySet(ctx) {
  return new Set(ctx.storage.get(LIBRARY_KEY) || []);
}

export function getWatchlistKeySet(ctx) {
  return new Set(ctx.storage.get(WATCHLIST_KEY) || []);
}

export function searchPeople(index, query, { limit = 40 } = {}) {
  const q = normalizePersonName(query);
  if (!q) return [];

  const buckets = [
    ['actor', index.actors || []],
    ['director', index.directors || []],
    ['writer', index.writers || []],
  ];
  const hits = [];
  for (const [role, list] of buckets) {
    for (const person of list) {
      if (!person.nameKey?.includes(q) && !normalizePersonName(person.name).includes(q)) {
        continue;
      }
      hits.push({ ...person, role });
    }
  }
  hits.sort((a, b) => b.weight - a.weight);
  return hits.slice(0, limit);
}

async function fetchAllLibraryItems(ctx, libraryId, type) {
  const all = [];
  let start = 0;
  const size = 100;
  let total = Infinity;
  while (start < total) {
    const page = await ctx.plex.getLibraryItems(libraryId, { type, start, size });
    all.push(...(page.items || []));
    total = Number(page.total ?? all.length);
    if (!page.items?.length) break;
    start += page.items.length;
  }
  return all;
}

function addLibraryKeys(set, item) {
  const { keys } = identityKeys(item);
  for (const k of keys) set.add(k);
}

function accumulateCredits(people, item, weight, titleRef) {
  addPeople(people.actors, item.roles || [], weight, titleRef);
  addPeople(people.directors, item.directors || [], weight, titleRef);
  addPeople(people.writers, item.writers || [], weight, titleRef);
  for (const genre of item.genres || []) {
    const name = String(genre || '').trim();
    if (!name) continue;
    const nameKey = normalizePersonName(name);
    bump(people.genres, nameKey, name, weight, titleRef);
  }
}

function addPeople(map, list, weight, titleRef) {
  for (const person of list) {
    const name = String(person.tag || person.name || '').trim();
    if (!name) continue;
    const nameKey = normalizePersonName(name);
    bump(map, nameKey, name, weight, titleRef);
  }
}

function bump(map, nameKey, name, weight, titleRef) {
  let entry = map.get(nameKey);
  if (!entry) {
    entry = {
      name,
      nameKey,
      weight: 0,
      titles: [],
      titleKeys: new Set(),
    };
    map.set(nameKey, entry);
  }
  entry.weight += weight;
  const tKey = `${titleRef.type}:${titleRef.ratingKey}`;
  if (!entry.titleKeys.has(tKey)) {
    entry.titleKeys.add(tKey);
    entry.titles.push({
      ratingKey: titleRef.ratingKey,
      title: titleRef.title,
      year: titleRef.year,
      type: titleRef.type,
      weight,
    });
  } else {
    const existing = entry.titles.find(
      (t) => t.ratingKey === titleRef.ratingKey && t.type === titleRef.type,
    );
    if (existing) existing.weight += weight;
  }
}

function rankMap(map) {
  return [...map.values()]
    .map((entry) => ({
      name: entry.name,
      nameKey: entry.nameKey,
      weight: entry.weight,
      titleCount: entry.titles.length,
      titles: entry.titles
        .slice()
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 20),
    }))
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
}

function emptyIndex() {
  return {
    updatedAt: null,
    stats: {
      moviesScanned: 0,
      showsScanned: 0,
      watchedMovies: 0,
      watchedShows: 0,
    },
    actors: [],
    directors: [],
    writers: [],
    genres: [],
  };
}
