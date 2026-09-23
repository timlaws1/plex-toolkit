import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGuids, identityKeys } from '../lib/guids.js';
import {
  normalizeTitle,
  normalizePersonName,
  extractYear,
  titleMatchScore,
  mediaTypeAllowed,
} from '../lib/normalize.js';
import { parseXmltvWindow, parseXmltvTime, collapseAirings } from '../lib/epg.js';
import { classifyChannel, pickPrimaryChannel, compactAlsoOn, derivePreferredRegion } from '../lib/channels.js';
import {
  findWatchlistHit,
  findFilmographyHit,
  trackPerson,
  getTrackedPeople,
  libraryHasTitle,
} from '../lib/match.js';
import { createTmdbClient } from '../lib/tmdb.js';

test('parseGuids extracts tmdb and imdb', () => {
  const parsed = parseGuids(
    ['plex://movie/abc', 'tmdb://movie/550', 'imdb://tt0137523'],
    'movie',
  );
  assert.equal(parsed.tmdbId, 550);
  assert.equal(parsed.imdbId, 'tt0137523');
  assert.equal(parsed.mediaType, 'movie');
  assert.ok(parsed.keys.includes('tmdb:movie:550'));
  assert.ok(parsed.keys.includes('imdb:tt0137523'));
});

test('identityKeys uses show type as tv', () => {
  const id = identityKeys({
    type: 'show',
    guids: ['tmdb://123'],
  });
  assert.equal(id.mediaType, 'tv');
  assert.ok(id.keys.includes('tmdb:tv:123'));
});

test('normalize helpers', () => {
  assert.equal(normalizeTitle('Slow Horses (2022)'), 'slow horses');
  assert.equal(extractYear('Slow Horses (2022)'), 2022);
  assert.equal(normalizePersonName('Gary  Oldman!'), 'gary oldman');
});

test('titleMatchScore is exact only — Babylon vs Babylon 5', () => {
  assert.ok(titleMatchScore('Babylon', 'Babylon') >= 100);
  assert.equal(titleMatchScore('Babylon', 'Babylon 5'), 0);
  assert.equal(titleMatchScore('babylon 5', 'Babylon'), 0);
  assert.equal(
    titleMatchScore('Babylon', 'Babylon', {
      wantYear: 2022,
      candidateYear: 1994,
    }),
    0,
  );
  assert.ok(
    titleMatchScore('Babylon', 'Babylon', {
      wantYear: 2022,
      candidateYear: 2022,
    }) >= 100,
  );
});

test('mediaTypeAllowed respects toggles', () => {
  assert.equal(mediaTypeAllowed('movie', { matchMovies: true, matchTv: false }), true);
  assert.equal(mediaTypeAllowed('tv', { matchMovies: true, matchTv: false }), false);
  assert.equal(mediaTypeAllowed('movie', { matchMovies: false, matchTv: true }), false);
});

test('classifyChannel strips region HD and +1', () => {
  const a = classifyChannel('BBC One West Midlands');
  assert.equal(a.family, 'BBC One');
  assert.equal(a.isRegional, true);
  assert.equal(a.isHd, false);

  const b = classifyChannel('BBC One HD');
  assert.equal(b.family, 'BBC One');
  assert.equal(b.isHd, true);

  const c = classifyChannel('ITV +1');
  assert.equal(c.family, 'ITV');
  assert.equal(c.isPlus1, true);

  const d = classifyChannel('BBC 1 NW');
  assert.equal(d.family, 'BBC One');

  assert.equal(classifyChannel('Channel 4 Midlands HD').family, 'Channel 4');
  assert.equal(classifyChannel('Channel 4 ROI HD').family, 'Channel 4');
  assert.equal(classifyChannel('Channel 4+1 North').family, 'Channel 4');
  assert.equal(classifyChannel('BBC One Yorks & Lincs HD').family, 'BBC One');
  assert.equal(classifyChannel('ITV4+1').family, 'ITV4');
});

test('pickPrimaryChannel prefers SD non-+1', () => {
  const primary = pickPrimaryChannel([
    { name: 'BBC One HD', isHd: true, isPlus1: false, isRegional: false },
    { name: 'BBC One +1', isHd: false, isPlus1: true, isRegional: false },
    { name: 'BBC One', isHd: false, isPlus1: false, isRegional: false },
  ]);
  assert.equal(primary.name, 'BBC One');
});

test('findWatchlistHit does not match Babylon movie to Babylon 5', () => {
  const airing = {
    titleNormalized: 'babylon 5',
    parsedYear: null,
    mediaTypeHint: 'tv',
    rawTitle: 'Babylon 5',
  };
  const items = [
    {
      title: 'Babylon',
      titleNormalized: 'babylon',
      year: 2022,
      type: 'movie',
      keys: ['tmdb:movie:1'],
    },
  ];
  assert.equal(findWatchlistHit(airing, items), null);

  const movieAiring = {
    titleNormalized: 'babylon',
    parsedYear: 2022,
    mediaTypeHint: 'movie',
    rawTitle: 'Babylon (2022)',
  };
  const hit = findWatchlistHit(movieAiring, items);
  assert.ok(hit);
  assert.equal(hit.title, 'Babylon');
  assert.equal(hit.mediaType, 'movie');
});

test('parseXmltvTime and collapse regional variants', () => {
  const d = parseXmltvTime('20260922120000 +0000');
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString(), '2026-09-22T12:00:00.000Z');

  const futureStart = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const y = futureStart.getUTCFullYear();
  const mo = String(futureStart.getUTCMonth() + 1).padStart(2, '0');
  const day = String(futureStart.getUTCDate()).padStart(2, '0');
  const h = String(futureStart.getUTCHours()).padStart(2, '0');
  const mi = String(futureStart.getUTCMinutes()).padStart(2, '0');
  const s = String(futureStart.getUTCSeconds()).padStart(2, '0');
  const startAttr = `${y}${mo}${day}${h}${mi}${s} +0000`;

  const xml = `<?xml version="1.0"?>
    <tv>
      <channel id="bbc1wm"><display-name>BBC One West Midlands</display-name></channel>
      <channel id="bbc1nw"><display-name>BBC One North West</display-name></channel>
      <channel id="bbc1hd"><display-name>BBC One HD</display-name></channel>
      <channel id="bbc1p1"><display-name>BBC One +1</display-name></channel>
      <programme start="${startAttr}" stop="${startAttr}" channel="bbc1wm">
        <title>Slow Horses</title>
        <category>Series</category>
      </programme>
      <programme start="${startAttr}" stop="${startAttr}" channel="bbc1nw">
        <title>Slow Horses</title>
        <category>Series</category>
      </programme>
      <programme start="${startAttr}" stop="${startAttr}" channel="bbc1hd">
        <title>Slow Horses</title>
        <category>Series</category>
      </programme>
      <programme start="${startAttr}" stop="${startAttr}" channel="bbc1p1">
        <title>Slow Horses</title>
        <category>Series</category>
      </programme>
      <programme start="20200101120000 +0000" channel="bbc1wm">
        <title>Old Show</title>
      </programme>
    </tv>`;

  const programmes = parseXmltvWindow(xml, 7);
  assert.equal(programmes.length, 1);
  assert.equal(programmes[0].rawTitle, 'Slow Horses');
  assert.equal(programmes[0].channelFamily, 'BBC One');
  assert.equal(programmes[0].mediaTypeHint, 'tv');
  assert.ok(
    ['BBC One West Midlands', 'BBC One North West'].includes(
      programmes[0].channel,
    ),
  );
  assert.ok(programmes[0].alsoOn.includes('HD') || programmes[0].alsoOn.includes('+1'));
  assert.equal(programmes[0].channels.length, 4);
});

test('collapseAirings merges same family within 2 minutes', () => {
  const base = Date.now() + 3600_000;
  const collapsed = collapseAirings([
    {
      titleNormalized: 'foo',
      channelFamily: 'BBC One',
      startMs: base,
      startsAt: new Date(base).toISOString(),
      channel: 'BBC One',
      mediaTypeHint: 'tv',
      channels: [{ name: 'BBC One', isHd: false, isPlus1: false, isRegional: false }],
    },
    {
      titleNormalized: 'foo',
      channelFamily: 'BBC One',
      startMs: base + 60_000,
      startsAt: new Date(base + 60_000).toISOString(),
      channel: 'BBC One HD',
      mediaTypeHint: 'tv',
      channels: [{ name: 'BBC One HD', isHd: true, isPlus1: false, isRegional: false }],
    },
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].alsoOn.length, 1);
});

test('collapseAirings folds +1 hour offset into primary', () => {
  const base = Date.now() + 3600_000;
  const collapsed = collapseAirings([
    {
      titleNormalized: 'rocky ii',
      channelFamily: 'ITV4',
      startMs: base,
      startsAt: new Date(base).toISOString(),
      channel: 'ITV4 HD',
      isPlus1: false,
      mediaTypeHint: 'movie',
      channels: [{ name: 'ITV4 HD', isHd: true, isPlus1: false, isRegional: false }],
    },
    {
      titleNormalized: 'rocky ii',
      channelFamily: 'ITV4',
      startMs: base + 60 * 60 * 1000,
      startsAt: new Date(base + 60 * 60 * 1000).toISOString(),
      channel: 'ITV4+1',
      isPlus1: true,
      mediaTypeHint: 'movie',
      channels: [{ name: 'ITV4+1', isHd: false, isPlus1: true, isRegional: false }],
    },
  ]);
  assert.equal(collapsed.length, 1);
  assert.ok(
    collapsed[0].alsoOn.includes('+1') ||
      collapsed[0].alsoOn.includes('ITV4+1') ||
      collapsed[0].channel === 'ITV4+1',
  );
});

test('libraryHasTitle matches watchlist keys', () => {
  const library = new Set(['tmdb:movie:615777', 'imdb:tt16368146']);
  assert.equal(
    libraryHasTitle(library, {
      tmdbId: 615777,
      mediaType: 'movie',
      keys: ['tmdb:movie:615777'],
    }),
    true,
  );
  assert.equal(
    libraryHasTitle(library, {
      tmdbId: 999,
      mediaType: 'movie',
      keys: ['tmdb:movie:999'],
    }),
    false,
  );
});

test('pickPrimaryChannel prefers configured region', () => {
  const primary = pickPrimaryChannel(
    [
      { name: 'BBC One North West', isHd: false, isPlus1: false, isRegional: true },
      { name: 'BBC One West Midlands', isHd: false, isPlus1: false, isRegional: true },
      { name: 'BBC One HD', isHd: true, isPlus1: false, isRegional: false },
    ],
    { preferredRegion: 'West Midlands' },
  );
  assert.equal(primary.name, 'BBC One West Midlands');
});

test('compactAlsoOn hides regional dump', () => {
  const also = compactAlsoOn(
    [
      { name: 'BBC One West Midlands', isRegional: true },
      { name: 'BBC One North West', isRegional: true },
      { name: 'BBC One HD', isHd: true },
      { name: 'BBC One +1', isPlus1: true },
    ],
    'BBC One West Midlands',
  );
  assert.ok(also.includes('HD'));
  assert.ok(also.includes('+1'));
  assert.ok(!also.some((x) => /North West/i.test(x)));
});

test('derivePreferredRegion from DVR-like titles', () => {
  const region = derivePreferredRegion([
    'BBC One West Midlands',
    'ITV West Midlands',
    'BBC Two',
    'Film4',
  ]);
  assert.ok(/west midlands/i.test(region));
});

function mockCtx(initial = {}) {
  const store = { ...initial };
  return {
    storage: {
      get: (k) => store[k],
      set: (k, v) => {
        store[k] = v;
      },
    },
  };
}

test('trackPerson stores tmdbPersonId; name-only marked null', () => {
  const ctx = mockCtx();
  trackPerson(ctx, {
    name: 'Cary Grant',
    tmdbPersonId: 829,
    profilePath: '/x.jpg',
  });
  let list = getTrackedPeople(ctx);
  assert.equal(list.length, 1);
  assert.equal(list[0].tmdbPersonId, 829);
  assert.equal(list[0].nameKey, 'cary grant');

  trackPerson(ctx, { name: 'Legacy Actor' });
  list = getTrackedPeople(ctx);
  const legacy = list.find((p) => p.nameKey === 'legacy actor');
  assert.ok(legacy);
  assert.equal(legacy.tmdbPersonId, null);
});

test('findFilmographyHit matches exact title and year', () => {
  const entries = [
    {
      titleNormalized: normalizeTitle('North by Northwest'),
      title: 'North by Northwest',
      year: 1959,
      mediaType: 'movie',
      tmdbId: 213,
      personName: 'Cary Grant',
      tmdbPersonId: 829,
    },
    {
      titleNormalized: normalizeTitle('Babylon'),
      title: 'Babylon',
      year: 2022,
      mediaType: 'movie',
      tmdbId: 1,
      personName: 'Someone',
      tmdbPersonId: 1,
    },
  ];

  const hit = findFilmographyHit(
    {
      titleNormalized: 'north by northwest',
      parsedYear: 1959,
      mediaTypeHint: 'movie',
    },
    entries,
    { matchMovies: true, matchTv: true },
  );
  assert.ok(hit);
  assert.equal(hit.tmdbId, 213);
  assert.equal(hit.personName, 'Cary Grant');

  assert.equal(
    findFilmographyHit(
      {
        titleNormalized: 'babylon 5',
        parsedYear: null,
        mediaTypeHint: 'tv',
      },
      entries,
      { matchMovies: true, matchTv: true },
    ),
    null,
  );

  assert.equal(
    findFilmographyHit(
      {
        titleNormalized: 'north by northwest',
        parsedYear: 1959,
        mediaTypeHint: 'movie',
      },
      entries,
      { matchMovies: false, matchTv: true },
    ),
    null,
  );
});

test('createTmdbClient maps search and credits responses', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/search/person')) {
      return {
        ok: true,
        async json() {
          return {
            results: [
              {
                id: 829,
                name: 'Cary Grant',
                profile_path: '/cg.jpg',
                known_for_department: 'Acting',
                popularity: 12,
              },
            ],
          };
        },
      };
    }
    if (href.includes('/movie_credits')) {
      return {
        ok: true,
        async json() {
          return {
            cast: [
              {
                id: 213,
                title: 'North by Northwest',
                release_date: '1959-07-01',
              },
            ],
            crew: [
              {
                id: 99,
                title: 'Some Directed Film',
                release_date: '1960-01-01',
                job: 'Director',
                department: 'Directing',
              },
            ],
          };
        },
      };
    }
    if (href.includes('/tv_credits')) {
      return {
        ok: true,
        async json() {
          return {
            cast: [
              {
                id: 500,
                name: 'Alfred Hitchcock Presents',
                first_air_date: '1955-10-02',
              },
            ],
            crew: [],
          };
        },
      };
    }
    return { ok: false, status: 404, async text() { return 'no'; } };
  };

  try {
    const tmdb = createTmdbClient({ apiKey: 'test-key' });
    const people = await tmdb.searchPerson('Cary Grant');
    assert.equal(people.length, 1);
    assert.equal(people[0].tmdbPersonId, 829);
    assert.equal(people[0].name, 'Cary Grant');
    assert.equal(people[0].profilePath, '/cg.jpg');

    const credits = await tmdb.personFilmography(829);
    assert.ok(credits.some((c) => c.tmdbId === 213 && c.mediaType === 'movie' && c.year === 1959));
    assert.ok(credits.some((c) => c.tmdbId === 99 && c.role === 'director'));
    assert.ok(
      credits.some(
        (c) => c.tmdbId === 500 && c.mediaType === 'tv' && c.title === 'Alfred Hitchcock Presents',
      ),
    );
    assert.ok(calls.every((u) => u.includes('api_key=test-key')));
  } finally {
    globalThis.fetch = original;
  }
});
