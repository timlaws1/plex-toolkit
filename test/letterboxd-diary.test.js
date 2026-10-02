import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateManifest } from '../src/plugins/manifest.js';
import { planDiary, planUnmark, watchesFromFiles } from '../tools/letterboxd-diary/lib/diary.js';
import { buildIndex, guidKeys, matchFilm } from '../tools/letterboxd-diary/lib/library.js';
import { diaryRssUrl, parseDiaryRss } from '../tools/letterboxd-diary/lib/rss.js';
import { _internal, handleRequest } from '../tools/letterboxd-diary/plugin.js';

function storedZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const entries = Object.entries(files);
  for (const [name, text] of entries) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

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
        batches.push({ id, title, summary, undone: false, dry_run: false, created_at: 'now', payload: { changes, meta } });
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

test('diary manifest is valid', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('../tools/letterboxd-diary/plugin.json', import.meta.url), 'utf8'));
  const result = validateManifest(raw);
  assert.deepEqual(result.errors, []);
});

test('guidKeys normalizes modern and legacy agent guids', () => {
  assert.deepEqual(
    guidKeys({
      guid: 'plex://movie/5D776B59AD5437001F79C6F8',
      guids: ['tmdb://27205', 'imdb://tt1375666', 'com.plexapp.agents.themoviedb://27205?lang=en'],
    }).sort(),
    ['imdb://tt1375666', 'plex://movie/5d776b59ad5437001f79c6f8', 'tmdb://27205'],
  );
});

test('matchFilm prefers guids, then exact title and year', () => {
  const index = buildIndex([
    { ratingKey: '1', title: 'Inception', year: 2010, guids: ['tmdb://27205'] },
    { ratingKey: '2', title: 'Dune', year: 1984, guids: ['tmdb://841'] },
    { ratingKey: '3', title: 'Dune', year: 2021, guids: ['tmdb://438631'] },
    { ratingKey: '4', title: 'Solaris', year: 2002, guids: ['tmdb://2103'] },
    { ratingKey: '5', title: 'Solaris', year: 2002, guids: ['tmdb://593'] },
    { ratingKey: '6', title: 'Amélie', year: 2001, guids: ['tmdb://194'] },
    { ratingKey: '7', title: 'Amélie', year: 2001, guids: ['tmdb://194', 'plex://movie/abc'] },
  ]);

  const byGuid = matchFilm(index, { title: 'Wrong title', year: 1999, guids: ['tmdb://27205'] });
  assert.equal(byGuid.status, 'matched');
  assert.deepEqual(byGuid.items.map((i) => i.ratingKey), ['1']);

  const byTitle = matchFilm(index, { title: 'Dune', year: 2021 });
  assert.equal(byTitle.status, 'matched');
  assert.deepEqual(byTitle.items.map((i) => i.ratingKey), ['3']);

  assert.equal(matchFilm(index, { title: 'Dune', year: 2000 }).status, 'missing');
  assert.equal(matchFilm(index, { title: 'Solaris', year: 2002 }).status, 'ambiguous');
  assert.equal(matchFilm(index, { title: 'Dune', year: null }).status, 'ambiguous');

  const copies = matchFilm(index, { title: 'Amelie', year: 2001 });
  assert.equal(copies.status, 'matched');
  assert.deepEqual(copies.items.map((i) => i.ratingKey), ['6', '7']);
});

test('watchesFromFiles reads watched and diary rows once each and ignores ratings', () => {
  const files = new Map([
    ['ratings.csv', 'Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,Rated Only,2000,https://boxd.it/r,4\n'],
    ['watched.csv', 'Date,Name,Year,Letterboxd URI\n2024-01-01,Inception,2010,https://boxd.it/a\n2024-01-02,"Crouching Tiger, Hidden Dragon",2000,https://boxd.it/b\n'],
    ['diary.csv', 'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2024-02-01,Inception,2010,https://boxd.it/x1,5,Yes,,2024-02-01\n2024-02-03,Heat,1995,https://boxd.it/x2,4,,,2024-02-03\n'],
  ]);
  const films = watchesFromFiles(files);
  assert.deepEqual(films.map((f) => `${f.title}|${f.year}`), [
    'Inception|2010',
    'Crouching Tiger, Hidden Dragon|2000',
    'Heat|1995',
  ]);
  assert.throws(() => watchesFromFiles(new Map([['ratings.csv', 'Name\nX\n']])), /watched\.csv or diary\.csv/);
});

test('planDiary sorts films into mark, already watched, missing, and ambiguous', () => {
  const index = buildIndex([
    { ratingKey: '1', title: 'Inception', year: 2010, viewCount: 0 },
    { ratingKey: '2', title: 'Heat', year: 1995, viewCount: 3 },
    { ratingKey: '3', title: 'Solaris', year: 2002, viewCount: 0, guids: ['tmdb://1'] },
    { ratingKey: '4', title: 'Solaris', year: 2002, viewCount: 0, guids: ['tmdb://2'] },
  ]);
  const plan = planDiary(
    [
      { title: 'Inception', year: 2010 },
      { title: 'Heat', year: 1995 },
      { title: 'Solaris', year: 2002 },
      { title: 'Arrival', year: 2016 },
    ],
    index,
  );
  assert.deepEqual(plan.toMark.map((c) => c.ratingKey), ['1']);
  assert.deepEqual(plan.alreadyWatched.map((f) => f.title), ['Heat']);
  assert.deepEqual(plan.ambiguous.map((f) => f.title), ['Solaris']);
  assert.deepEqual(plan.missing.map((f) => f.title), ['Arrival']);
});

test('planUnmark leaves films played since unless forced', () => {
  const changes = [{ ratingKey: '1' }, { ratingKey: '2' }, { ratingKey: '3' }, { ratingKey: '4' }];
  const states = new Map([
    ['1', { viewCount: 1 }],
    ['2', { viewCount: 2 }],
    ['3', { viewCount: 0 }],
    ['4', null],
  ]);
  const plan = planUnmark(changes, states);
  assert.deepEqual(plan.apply.map((c) => c.ratingKey), ['1']);
  assert.deepEqual(plan.conflicts.map((c) => c.ratingKey), ['2']);
  assert.deepEqual(plan.skipped.map((c) => c.ratingKey), ['3', '4']);
  assert.deepEqual(planUnmark(changes, states, { force: true }).apply.map((c) => c.ratingKey), ['1', '2']);
});

test('parseDiaryRss keeps diary entries with their TMDb id', () => {
  const xml = `<rss><channel>
    <item>
      <title>Inception, 2010 - ★★★★</title>
      <link>https://letterboxd.com/dave/film/inception/</link>
      <guid isPermaLink="false">letterboxd-review-1</guid>
      <letterboxd:watchedDate>2024-03-01</letterboxd:watchedDate>
      <letterboxd:filmTitle>Inception</letterboxd:filmTitle>
      <letterboxd:filmYear>2010</letterboxd:filmYear>
      <tmdb:movieId>27205</tmdb:movieId>
    </item>
    <item>
      <title>Favourite films</title>
      <link>https://letterboxd.com/dave/list/favourite-films/</link>
      <guid isPermaLink="false">letterboxd-list-2</guid>
    </item>
  </channel></rss>`;
  assert.deepEqual(parseDiaryRss(xml), [
    {
      guid: 'letterboxd-review-1',
      title: 'Inception',
      year: 2010,
      uri: 'https://letterboxd.com/dave/film/inception/',
      watchedDate: '2024-03-01',
      guids: ['tmdb://27205'],
    },
  ]);
  assert.equal(diaryRssUrl('@Dave'), 'https://letterboxd.com/Dave/rss/');
  assert.throws(() => diaryRssUrl('bad name'), /Invalid/);
});

test('preview, apply, and undo mark only unwatched library films', async () => {
  const library = [
    { ratingKey: '10', title: 'Inception', year: 2010, viewCount: 0, librarySectionID: '1' },
    { ratingKey: '11', title: 'Heat', year: 1995, viewCount: 2, librarySectionID: '1' },
  ];
  const calls = [];
  const ctx = fakeCtx({
    settings: { libraries: ['1', '2'] },
    plex: {
      isConfigured: () => true,
      getLibraries: async () => [
        { id: '1', type: 'movie', title: 'Films' },
        { id: '2', type: 'show', title: 'TV' },
      ],
      async getLibraryItems(id, { start }) {
        assert.equal(id, '1');
        return { items: start ? [] : library.map((i) => ({ ...i })), total: library.length };
      },
      async markWatched(ratingKey) {
        calls.push(['watched', ratingKey]);
        library.find((i) => i.ratingKey === ratingKey).viewCount = 1;
      },
      async markUnwatched(ratingKey) {
        calls.push(['unwatched', ratingKey]);
        library.find((i) => i.ratingKey === ratingKey).viewCount = 0;
      },
      async getWatchState(ratingKey) {
        const item = library.find((i) => i.ratingKey === ratingKey);
        return { ratingKey, watched: item.viewCount > 0, viewCount: item.viewCount };
      },
    },
  });

  const zip = storedZip({
    'watched.csv': 'Date,Name,Year,Letterboxd URI\n2024-01-01,Inception,2010,https://boxd.it/a\n2024-01-02,Heat,1995,https://boxd.it/b\n2024-01-03,Arrival,2016,https://boxd.it/c\n',
  });
  await handleRequest(ctx, { method: 'POST', body: { action: 'preview', zip_base64: zip.toString('base64') } });
  const pending = ctx.storage.get('pending');
  assert.equal(pending.filmCount, 3);
  assert.deepEqual(pending.toMark.map((c) => c.ratingKey), ['10']);
  assert.equal(pending.alreadyWatchedCount, 1);
  assert.equal(pending.missingCount, 1);
  assert.equal(calls.length, 0);

  const applied = await handleRequest(ctx, { method: 'POST', body: { action: 'apply' } });
  assert.match(applied.message, /Marked 1 films watched/);
  assert.deepEqual(calls, [['watched', '10']]);
  assert.equal(ctx.storage.get('pending'), null);
  assert.equal(ctx.batches.length, 1);

  const undone = await _internal.undoBatch(ctx, 1);
  assert.match(undone.message, /1 films marked unwatched/);
  assert.deepEqual(calls.at(-1), ['unwatched', '10']);
  assert.equal(ctx.batches[0].undone, true);
});
