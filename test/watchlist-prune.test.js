import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateManifest } from '../src/plugins/manifest.js';
import { planAgeRemovals, planWatchedRemovals, updateFirstSeen } from '../tools/watchlist-prune/lib/prune.js';
import { _internal } from '../tools/watchlist-prune/plugin.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function fakeCtx({ settings, plex }) {
  const storage = new Map();
  const batches = [];
  return {
    settings: { get: () => settings },
    storage: {
      get: (key) => (storage.has(key) ? structuredClone(storage.get(key)) : null),
      set: (key, value) => storage.set(key, structuredClone(value)),
      delete: (key) => storage.delete(key),
    },
    changes: {
      recordBatch({ title, summary, changes, meta }) {
        const id = batches.length + 1;
        batches.push({ id, title, summary, undone: false, created_at: 'now', payload: { changes, meta } });
        return id;
      },
      list: () => [...batches].reverse(),
      get: (id) => batches.find((b) => b.id === id) || null,
      markUndone: (id) => {
        const batch = batches.find((b) => b.id === id);
        if (batch) batch.undone = true;
      },
    },
    panels: { add() {} },
    log: { info() {}, warn() {}, error() {} },
    plex,
    batches,
  };
}

test('prune manifest is valid', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../tools/watchlist-prune/plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateManifest(raw).errors, []);
});

test('planWatchedRemovals matches by guid, then title and year, and skips ambiguous or kept', () => {
  const watchlist = [
    { ratingKey: 'w1', type: 'movie', title: 'Inception', year: 2010, guid: 'plex://movie/aaa', guids: ['tmdb://27205'] },
    { ratingKey: 'w2', type: 'movie', title: 'Heat', year: 1995, guids: [] },
    { ratingKey: 'w3', type: 'movie', title: 'Solaris', year: 2002, guids: ['tmdb://1'] },
    { ratingKey: 'w4', type: 'movie', title: 'Solaris', year: 2002, guids: ['tmdb://2'] },
    { ratingKey: 'w5', type: 'movie', title: 'Arrival', year: 2016, guids: [] },
    { ratingKey: 'w6', type: 'show', title: 'Severance', year: 2022, guids: [] },
  ];
  const watched = [
    { ratingKey: 'l1', title: 'Inception (4K)', year: 2010, viewCount: 1, guid: 'plex://movie/aaa' },
    { ratingKey: 'l2', title: 'Heat', year: 1995, viewCount: 2, guids: [] },
    { ratingKey: 'l3', title: 'Solaris', year: 2002, viewCount: 1, guids: [] },
    { ratingKey: 'l4', title: 'Arrival', year: 2016, viewCount: 1, guids: [] },
    { ratingKey: 'l5', title: 'Severance', year: 2022, viewCount: 0, guids: [] },
  ];
  const plan = planWatchedRemovals(watchlist, watched, new Set(['w5']));
  assert.deepEqual(plan.removals.map((r) => r.entry.ratingKey), ['w1', 'w2']);
  assert.equal(plan.removals[0].libraryRatingKey, 'l1');
  assert.deepEqual(plan.ambiguous.map((f) => f.title), ['Solaris']);
});

test('first-seen clock starts on first sight and drives age removals', () => {
  const start = Date.parse('2026-01-01T00:00:00Z');
  const watchlist = [
    { ratingKey: 'a', type: 'movie', title: 'Old' },
    { ratingKey: 'b', type: 'movie', title: 'Kept' },
  ];
  let seen = updateFirstSeen({}, watchlist, new Date(start).toISOString());
  assert.deepEqual(Object.keys(seen).sort(), ['a', 'b']);

  const later = [...watchlist, { ratingKey: 'c', type: 'movie', title: 'New' }];
  seen = updateFirstSeen(seen, later, new Date(start + 40 * DAY_MS).toISOString());
  assert.equal(seen.a, new Date(start).toISOString());
  assert.equal(seen.c, new Date(start + 40 * DAY_MS).toISOString());

  const removals = planAgeRemovals(later, seen, start + 40 * DAY_MS, 30, new Set(['b']));
  assert.deepEqual(removals.map((r) => [r.entry.ratingKey, r.ageDays]), [['a', 40]]);
  assert.deepEqual(planAgeRemovals(later, seen, start + 40 * DAY_MS, 0), []);

  const gone = updateFirstSeen(seen, [watchlist[1]], new Date(start + 41 * DAY_MS).toISOString());
  assert.deepEqual(Object.keys(gone), ['b']);
});

test('sweep removes watched films, and put back re-adds and keeps them', async () => {
  let watchlist = [
    { ratingKey: 'w1', type: 'movie', title: 'Inception', year: 2010, guids: ['tmdb://27205'] },
    { ratingKey: 'w2', type: 'movie', title: 'Heat', year: 1995, guids: [] },
  ];
  const library = [
    { ratingKey: '10', title: 'Inception', year: 2010, viewCount: 1, guids: ['tmdb://27205'] },
    { ratingKey: '11', title: 'Heat', year: 1995, viewCount: 0, guids: [] },
  ];
  const calls = [];
  const ctx = fakeCtx({
    settings: { enabled: true, libraries: ['1'], maxAgeDays: 0 },
    plex: {
      getLibraries: async () => [{ id: '1', type: 'movie', title: 'Films' }],
      getLibraryItems: async (id, { start }) => ({ items: start ? [] : library, total: library.length }),
      getWatchlist: async () => watchlist.map((e) => ({ ...e })),
      async removeFromWatchlist(key) {
        calls.push(['remove', key]);
        watchlist = watchlist.filter((e) => e.ratingKey !== key);
      },
      async addToWatchlist(key) {
        calls.push(['add', key]);
        watchlist.push({ ratingKey: key, type: 'movie', title: 'Inception', year: 2010, guids: ['tmdb://27205'] });
      },
    },
  });

  await _internal.sweep(ctx);
  assert.deepEqual(calls, [['remove', 'w1']]);
  assert.equal(ctx.batches.length, 1);
  assert.equal(ctx.batches[0].title, 'Inception (2010)');

  const result = await _internal.putBack(ctx, 1);
  assert.match(result.message, /back on your watchlist/);
  assert.deepEqual(calls.at(-1), ['add', 'w1']);
  assert.deepEqual(ctx.storage.get('kept'), ['w1']);

  await _internal.sweep(ctx);
  assert.equal(calls.filter(([op]) => op === 'remove').length, 1);
});

test('a watch event removes the matching watchlist film', async () => {
  const calls = [];
  const ctx = fakeCtx({
    settings: { enabled: true, libraries: ['1'] },
    plex: {
      getLibraries: async () => [{ id: '1', type: 'movie', title: 'Films' }],
      getMetadata: async () => ({ ratingKey: '10', title: 'Heat', year: 1995, viewCount: 0, guids: ['imdb://tt0113277'] }),
      getWatchlist: async () => [{ ratingKey: 'w9', type: 'movie', title: 'Heat', year: 1995, guids: ['imdb://tt0113277'] }],
      removeFromWatchlist: async (key) => calls.push(key),
    },
  });
  await _internal.onMovieWatched(ctx, { ratingKey: '10', librarySectionID: '2' });
  assert.deepEqual(calls, []);
  await _internal.onMovieWatched(ctx, { ratingKey: '10', librarySectionID: '1' });
  assert.deepEqual(calls, ['w9']);
});
