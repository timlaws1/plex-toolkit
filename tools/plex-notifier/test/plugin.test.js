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
import {
  classifyChannel,
  pickPrimaryChannel,
  compactAlsoOn,
  derivePreferredRegion,
  filterAiringsByLocation,
  filterDigestItems,
  isChannelExcluded,
  isRadioChannel,
  resolveExcludedChannels,
  DEFAULT_EXCLUDED_CHANNELS,
} from '../lib/channels.js';
import { renderDigestEmail } from '../lib/digest-mail.js';
import { parseXmltvWindow, parseXmltvTime, collapseAirings, inferMediaType } from '../lib/epg.js';
import {
  findWatchlistHit,
  findFilmographyHit,
  trackPerson,
  getTrackedPeople,
  libraryHasTitle,
  sendDigest,
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

test('resolveExcludedChannels defaults until explicitly cleared', () => {
  assert.deepEqual(resolveExcludedChannels(undefined), DEFAULT_EXCLUDED_CHANNELS);
  assert.deepEqual(resolveExcludedChannels([]), []);
  assert.ok(isChannelExcluded('France 24', DEFAULT_EXCLUDED_CHANNELS));
  assert.ok(isChannelExcluded('RTE One HD', DEFAULT_EXCLUDED_CHANNELS));
  assert.equal(isChannelExcluded('BBC One', DEFAULT_EXCLUDED_CHANNELS), false);
});

test('filterAiringsByLocation drops excluded and off-DVR channels', () => {
  const airings = [
    {
      channel: 'France 24',
      channelFamily: 'France 24',
      channels: [{ name: 'France 24' }],
    },
    {
      channel: 'RTE One',
      channelFamily: 'RTE One',
      channels: [{ name: 'RTE One' }],
    },
    {
      channel: 'BBC One West Midlands',
      channelFamily: 'BBC One',
      channels: [{ name: 'BBC One West Midlands', family: 'BBC One' }],
    },
    {
      channel: 'Sky Arts',
      channelFamily: 'Sky Arts',
      channels: [{ name: 'Sky Arts' }],
    },
  ];

  const filtered = filterAiringsByLocation(airings, {
    excludedChannels: DEFAULT_EXCLUDED_CHANNELS,
    restrictToDvr: true,
    dvrChannelTitles: ['BBC One West Midlands', 'ITV', 'Film4'],
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].channelFamily, 'BBC One');
});

test('isRadioChannel detects Freeview radio stations', () => {
  assert.equal(isRadioChannel('BBC Radio 2'), true);
  assert.equal(isRadioChannel('Classic FM'), true);
  assert.equal(isRadioChannel('talkSPORT'), true);
  assert.equal(isRadioChannel('Heart'), true);
  assert.equal(isRadioChannel('BBC One'), false);
  assert.equal(isRadioChannel('Film4'), false);
  assert.equal(isRadioChannel('Talking Pictures TV'), false);
});

test('inferMediaType and parseXmltvWindow drop radio programmes', () => {
  assert.equal(inferMediaType(['Radio']), 'radio');
  assert.equal(inferMediaType(['Film']), 'movie');

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
      <channel id="radio2"><display-name>BBC Radio 2</display-name></channel>
      <channel id="film4"><display-name>Film4</display-name></channel>
      <programme start="${startAttr}" stop="${startAttr}" channel="radio2">
        <title>Inception</title>
        <category>Radio</category>
      </programme>
      <programme start="${startAttr}" stop="${startAttr}" channel="film4">
        <title>Inception</title>
        <category>Film</category>
      </programme>
    </tv>`;

  const programmes = parseXmltvWindow(xml, 7);
  assert.equal(programmes.length, 1);
  assert.equal(programmes[0].channelFamily, 'Film4');
  assert.equal(programmes[0].mediaTypeHint, 'movie');
});

test('filterDigestItems drops radio, foreign, and off-DVR channels', () => {
  const items = [
    { title: 'News', channel: 'France 24', alsoOn: ['RTE One'] },
    { title: 'The Archers', channel: 'BBC Radio 4', mediaType: 'radio' },
    { title: 'Elsewhere', channel: 'Sky Arts' },
    {
      title: 'Inception',
      channel: 'Film4',
      alsoOn: ['HD', 'France 24', '+1'],
      mediaType: 'movie',
      year: 2010,
      reason: 'watchlist',
      startsAt: '2026-09-24T20:00:00.000Z',
    },
  ];

  const kept = filterDigestItems(items, {
    excludedChannels: DEFAULT_EXCLUDED_CHANNELS,
    restrictToDvr: true,
    dvrChannelTitles: ['Film4', 'BBC One West Midlands'],
  });

  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, 'Inception');
  assert.deepEqual(kept[0].alsoOn, ['HD', '+1']);
});

test('renderDigestEmail is a card layout grouped by day', () => {
  const { subject, text, html } = renderDigestEmail([
    {
      title: 'Inception',
      year: 2010,
      channel: 'Film4',
      mediaType: 'movie',
      reason: 'watchlist',
      startsAt: '2026-09-24T20:00:00.000Z',
      alsoOn: ['HD'],
    },
    {
      title: 'The Apartment',
      year: 1960,
      channel: 'BBC Two',
      mediaType: 'movie',
      reason: 'tracked_person',
      personName: 'Jack Lemmon',
      startsAt: '2026-09-25T18:30:00.000Z',
    },
  ]);

  assert.match(subject, /2 titles on Freeview/);
  assert.match(html, /On Freeview this week/);
  assert.match(html, /Inception/);
  assert.match(html, /Film4/);
  assert.match(html, /On your watchlist/);
  assert.match(html, /Also on HD/);
  assert.match(html, /Featuring Jack Lemmon/);
  assert.equal(html.includes('toUTCString') || html.includes('GMT'), false);
  assert.match(text, /Inception/);
  assert.match(text, /The Apartment/);
});

test('sendDigest emails only channels that pass the match rules', async () => {
  const store = {
    pendingDigest: [
      { notifyKey: 'a', title: 'French news', channel: 'France 24' },
      { notifyKey: 'radio', title: 'Ken Bruce', channel: 'BBC Radio 2' },
      {
        notifyKey: 'b',
        title: 'Inception',
        channel: 'Film4',
        year: 2010,
        reason: 'watchlist',
        mediaType: 'movie',
        startsAt: '2026-09-24T20:00:00.000Z',
      },
    ],
    sentTitles: [],
  };
  let sentMail;
  const ctx = {
    storage: {
      get: (k) => store[k],
      set: (k, v) => {
        store[k] = v;
      },
    },
    settings: {
      get: () => ({
        smtpHost: 'smtp.example.com',
        smtpFrom: 'a@b.c',
        smtpTo: 'd@e.f',
        restrictToDvrChannels: false,
        excludedChannels: DEFAULT_EXCLUDED_CHANNELS,
      }),
    },
    mail: {
      send: async (msg) => {
        sentMail = msg;
      },
    },
  };

  const result = await sendDigest(ctx);
  assert.equal(result.sent, 1);
  assert.equal(result.skipped, 2);
  assert.match(sentMail.html, /Inception/);
  assert.equal(sentMail.html.includes('France 24'), false);
  assert.equal(sentMail.html.includes('BBC Radio 2'), false);
  assert.equal(sentMail.text.includes('GMT'), false);
  assert.deepEqual(store.pendingDigest, []);
  assert.deepEqual(store.sentTitles, ['b']);
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

test('scheduleRecordings uses Plex guid and mediaProviderID, not tmdb://', async () => {
  const { scheduleRecordings } = await import('../lib/match.js');
  const calls = [];
  const ctx = {
    storage: {
      get: () => [],
      set: () => {},
    },
    log: { info() {}, warn() {} },
    plex: {
      async getLibraries() {
        return [{ id: '7', type: 'movie', title: 'Movies' }];
      },
      async getSubscriptions() {
        return [];
      },
      async getDvrMediaProviderId() {
        return '13';
      },
      async searchDiscover() {
        return [
          {
            type: 'movie',
            title: 'Rocky II',
            year: 1979,
            ratingKey: 'abc',
            guid: 'plex://movie/5d7768294de0ee001fcc8f5b',
            guids: ['plex://movie/5d7768294de0ee001fcc8f5b'],
          },
        ];
      },
      async getSubscriptionTemplates() {
        return [];
      },
      async createSubscription(opts) {
        calls.push(opts);
        return { key: '1' };
      },
    },
  };

  const result = await scheduleRecordings(
    ctx,
    [
      {
        notifyKey: 'rocky-ii',
        title: { title: 'Rocky II', year: 1979, mediaType: 'movie', tmdbId: 123 },
        airing: { startsAt: '2026-09-24T20:00:00.000Z', channel: 'Film4' },
      },
    ],
    { recordLibrary: ['7'], autoRecord: true },
  );

  assert.equal(result.recorded, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.mediaProviderID, '13');
  assert.equal(calls[0].hints.guid, 'plex://movie/5d7768294de0ee001fcc8f5b');
  assert.ok(!String(calls[0].hints.guid || '').startsWith('tmdb:'));
});
