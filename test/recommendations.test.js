import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseCsvObjects } from '../tools/scheduled-recommendations/lib/csv.js';
import { buildTaste, selectRecommendations, titleKey } from '../tools/scheduled-recommendations/lib/engine.js';
import { filmsFromExportZip } from '../tools/scheduled-recommendations/lib/letterboxd.js';
import { parseLetterboxdRss } from '../tools/scheduled-recommendations/lib/rss.js';
import { isScheduleDue, scheduleFromBody, slotDate } from '../tools/scheduled-recommendations/lib/schedule.js';
import { createStore } from '../tools/scheduled-recommendations/lib/store.js';
import { readZipTextFiles } from '../tools/scheduled-recommendations/lib/zip.js';
import { openDatabase } from '../src/db/index.js';
import { allowlistForPermissions, createScopedSql } from '../src/plugins/sql-scope.js';
import { validateManifest } from '../src/plugins/manifest.js';

test('csv keeps quoted commas', () => {
  const rows = parseCsvObjects('Name,Review\n"The Holdovers","A quiet, funny film"\n');
  assert.equal(rows[0].Name, 'The Holdovers');
  assert.equal(rows[0].Review, 'A quiet, funny film');
});

test('letterboxd rss reads film tags without fetching pages', () => {
  const items = parseLetterboxdRss(`
    <rss><channel><item>
      <title>tim watched The Holdovers</title>
      <link>https://letterboxd.com/tim/film/the-holdovers/</link>
      <guid>lb-1</guid>
      <letterboxd:filmTitle>The Holdovers</letterboxd:filmTitle>
      <letterboxd:filmYear>2023</letterboxd:filmYear>
      <letterboxd:memberRating>4.5</letterboxd:memberRating>
    </item></channel></rss>
  `);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'The Holdovers');
  assert.equal(items[0].year, 2023);
  assert.equal(items[0].rating, 4.5);
  assert.equal(items[0].kind, 'watched');
  assert.match(items[0].uri, /\/film\/the-holdovers/);
});

test('export zip merges ratings and diary by letterboxd uri', () => {
  const zip = storedZip({
    'ratings.csv': 'Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,The Holdovers,2023,https://boxd.it/abc,5\n',
    'diary.csv': 'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2024-01-02,The Holdovers,2023,https://boxd.it/abc,5,No,comedy,2024-01-02\n',
    'watchlist.csv': 'Date,Name,Year,Letterboxd URI\n2024-02-01,Aftersun,2022,https://boxd.it/def\n',
  });
  const films = filmsFromExportZip(zip);
  const holdovers = films.find((film) => film.title === 'The Holdovers');
  assert.equal(holdovers.rating, 5);
  assert.equal(holdovers.watched, 1);
  assert.equal(holdovers.tags, 'comedy');
  assert.equal(films.find((film) => film.title === 'Aftersun').watchlist, 1);
});

test('engine prefers personal taste and in-library films over an unrelated popular title', () => {
  const taste = buildTaste([
    { rating: 5, genres: ['Comedy'], directors: ['Alexander Payne'], actors: ['Paul Giamatti'] },
    { rating: 1, genres: ['Horror'], directors: ['Someone Else'], actors: [] },
  ]);
  const picks = selectRecommendations([
    candidate({ title: 'Blockbuster', genres: ['Action'], voteAverage: 8.8, inLibrary: true }),
    candidate({ title: 'The Sideways', genres: ['Comedy'], directors: ['Alexander Payne'], actors: ['Paul Giamatti'], inLibrary: true, runtimeMinutes: 100 }),
    candidate({ title: 'Streaming Comedy', genres: ['Comedy'], directors: ['Alexander Payne'], inLibrary: false, runtimeMinutes: 100 }),
  ], taste, { count: 1, preferPlex: true, allowStreaming: true, output: 'watchlist', runtimeMax: 120 });
  assert.equal(picks[0].title, 'The Sideways');
});

test('collection output drops streaming-only titles', () => {
  const taste = buildTaste([{ rating: 5, genres: ['Drama'], directors: ['A'], actors: [] }]);
  const picks = selectRecommendations([
    candidate({ title: 'Only Streaming', genres: ['Drama'], directors: ['A'], inLibrary: false }),
    candidate({ title: 'On Plex', genres: ['Drama'], directors: ['A'], inLibrary: true }),
  ], taste, { count: 2, output: 'collection', allowStreaming: true, preferPlex: true });
  assert.deepEqual(picks.map((pick) => pick.title), ['On Plex']);
});

test('recent recommendations are skipped', () => {
  const taste = buildTaste([{ rating: 5, genres: ['Drama'], directors: ['A'], actors: [] }]);
  const again = candidate({ title: 'On Plex', genres: ['Drama'], directors: ['A'], inLibrary: true });
  const picks = selectRecommendations([again], taste, {
    count: 1,
    output: 'collection',
    recentKeys: new Set([titleKey('On Plex', 2020)]),
  });
  assert.equal(picks.length, 0);
});

test('schedule is due once per local day after its time', () => {
  const schedule = {
    enabled: 1,
    days: JSON.stringify([4]),
    time_local: '18:00',
  };
  const thursdayEvening = new Date(2026, 8, 24, 18, 5);
  assert.equal(thursdayEvening.getDay(), 4);
  assert.equal(isScheduleDue(schedule, thursdayEvening, null), true);
  assert.equal(isScheduleDue(schedule, thursdayEvening, slotDate(thursdayEvening)), false);
  assert.equal(isScheduleDue(schedule, new Date(2026, 8, 24, 17, 0), null), false);
});

test('schedule form reads weekday checkboxes', () => {
  const fields = scheduleFromBody({
    name: 'Friday Film Night',
    enabled: '1',
    day_5: '1',
    time_local: '19:30',
    film_count: '3',
    runtime_min: '90',
    runtime_max: '150',
    prefer_plex: '1',
    output_type: 'collection',
  });
  assert.equal(fields.name, 'Friday Film Night');
  assert.deepEqual(JSON.parse(fields.days), [5]);
  assert.equal(fields.film_count, 3);
  assert.equal(fields.runtime_min, 90);
});

test('recommendations sql cannot read preroll or host tables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-rec-'));
  const db = openDatabase(path.join(dir, 't.sqlite'));
  const sql = createScopedSql(db, allowlistForPermissions(['sql.recommendations']));
  sql.prepare('SELECT COUNT(*) AS n FROM rec_schedules').get();
  assert.throws(() => sql.prepare('SELECT * FROM preroll_state'), /disallowed/);
  assert.throws(() => sql.prepare('SELECT * FROM plex_servers'), /disallowed/);
  const store = createStore(sql);
  store.saveFilms([{
    uri: 'https://boxd.it/abc',
    title: 'The Holdovers',
    year: 2023,
    rating: 5,
    watched: 1,
    activity: [],
  }]);
  assert.equal(store.filmCount(), 1);
  const id = store.saveSchedule(scheduleFromBody({
    name: 'Tonight',
    enabled: '1',
    day_4: '1',
    time_local: '18:00',
    film_count: '1',
    prefer_plex: '1',
    output_type: 'collection',
  }), null);
  assert.equal(store.getSchedule(id).name, 'Tonight');
  db.close();
});

test('validateManifest accepts the recommendations tool', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join('tools', 'scheduled-recommendations', 'plugin.json'),
    'utf8',
  ));
  const result = validateManifest(manifest);
  assert.equal(result.ok, true, result.errors?.join('; '));
});

function candidate(partial) {
  return {
    key: titleKey(partial.title, partial.year || 2020),
    title: partial.title,
    year: partial.year || 2020,
    inLibrary: true,
    watched: false,
    runtimeMinutes: 100,
    genres: [],
    directors: [],
    actors: [],
    voteAverage: 6,
    ...partial,
  };
}

function storedZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const local = Buffer.alloc(30 + nameBuf.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    data.copy(local, 30 + nameBuf.length);
    locals.push(local);
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(filesLength(files), 8);
  eocd.writeUInt16LE(filesLength(files), 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  const zip = Buffer.concat([...locals, centralBuf, eocd]);
  const read = readZipTextFiles(zip);
  assert.equal(read.get('ratings.csv')?.includes('Holdovers'), true);
  return zip;
}

function filesLength(files) {
  return Object.keys(files).length;
}
