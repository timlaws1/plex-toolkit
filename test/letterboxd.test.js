import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWatchlistRss,
  splitTitleYear,
  watchlistRssUrl,
} from '../tools/letterboxd-watchlist/lib/rss.js';
import { runSync } from '../tools/letterboxd-watchlist/lib/sync.js';

const SAMPLE_RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>Letterboxd - Watchlist</title>
    <item>
      <title>Inception (2010)</title>
      <link>https://letterboxd.com/film/inception/</link>
      <guid>https://letterboxd.com/film/inception/</guid>
    </item>
    <item>
      <title>The Matrix (1999)</title>
      <link>https://letterboxd.com/film/the-matrix/</link>
      <guid>letterboxd-film-the-matrix</guid>
    </item>
    <item>
      <title><![CDATA[Dune (2021)]]></title>
      <link>https://letterboxd.com/film/dune-2021/</link>
    </item>
  </channel>
</rss>`;

test('splitTitleYear extracts title and year', () => {
  assert.deepEqual(splitTitleYear('Inception (2010)'), {
    title: 'Inception',
    year: 2010,
  });
  assert.deepEqual(splitTitleYear('Untitled'), {
    title: 'Untitled',
    year: null,
  });
});

test('watchlistRssUrl builds a public RSS URL', () => {
  assert.equal(
    watchlistRssUrl('someuser'),
    'https://letterboxd.com/someuser/watchlist/rss/',
  );
  assert.equal(
    watchlistRssUrl('https://letterboxd.com/someuser/'),
    'https://letterboxd.com/someuser/watchlist/rss/',
  );
  assert.throws(() => watchlistRssUrl(''), /required/);
});

test('parseWatchlistRss reads title year and link', () => {
  const items = parseWatchlistRss(SAMPLE_RSS);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    title: 'Inception',
    year: 2010,
    link: 'https://letterboxd.com/film/inception/',
    guid: 'https://letterboxd.com/film/inception/',
    titleRaw: 'Inception (2010)',
  });
  assert.equal(items[2].title, 'Dune');
  assert.equal(items[2].year, 2021);
});

test('runSync skips titles already on the Plex watchlist and adds the rest', async () => {
  const added = [];
  const storage = new Map();
  const ctx = {
    settings: {
      get() {
        return { letterboxdUsername: 'demo', enabled: true };
      },
    },
    storage: {
      get(key) {
        return storage.get(key) ?? null;
      },
      set(key, value) {
        storage.set(key, value);
      },
    },
    plex: {
      async getWatchlist() {
        return [{ ratingKey: '1', title: 'Inception', year: 2010, type: 'movie' }];
      },
      async searchDiscover(query) {
        if (String(query).includes('Inception')) {
          return [{ ratingKey: '1', title: 'Inception', year: 2010, type: 'movie' }];
        }
        if (String(query).includes('Matrix')) {
          return [{ ratingKey: '2', title: 'The Matrix', year: 1999, type: 'movie' }];
        }
        if (String(query).includes('Dune')) {
          return [{ ratingKey: '3', title: 'Dune', year: 2021, type: 'movie' }];
        }
        return [];
      },
      async addToWatchlist(ratingKey) {
        added.push(String(ratingKey));
        return { ok: true, ratingKey: String(ratingKey) };
      },
    },
  };

  const result = await runSync(ctx, {
    fetchRss: async () => ({
      ok: true,
      async text() {
        return SAMPLE_RSS;
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, 1);
  assert.equal(result.added, 2);
  assert.equal(result.unmatched, 0);
  assert.deepEqual(added.sort(), ['2', '3']);
  assert.ok(storage.get('lastSync')?.at);
});

test('runSync records unmatched titles without calling addToWatchlist', async () => {
  const added = [];
  const storage = new Map();
  const ctx = {
    settings: {
      get() {
        return { letterboxdUsername: 'demo', enabled: true };
      },
    },
    storage: {
      get(key) {
        return storage.get(key) ?? null;
      },
      set(key, value) {
        storage.set(key, value);
      },
    },
    plex: {
      async getWatchlist() {
        return [];
      },
      async searchDiscover() {
        return [];
      },
      async addToWatchlist(ratingKey) {
        added.push(String(ratingKey));
      },
    },
  };

  const result = await runSync(ctx, {
    fetchRss: async () => ({
      ok: true,
      async text() {
        return SAMPLE_RSS;
      },
    }),
  });

  assert.equal(result.added, 0);
  assert.equal(result.unmatched, 3);
  assert.equal(added.length, 0);
});
