import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { cleanFilmTitle } from '../tools/trailer-fetcher/lib/traileraddict.js';
import {
  isPastRetention,
  TrailerFetcherService,
} from '../tools/trailer-fetcher/lib/service.js';
import { runMigrations } from '../tools/trailer-fetcher/lib/migrations.js';
import { openDatabase } from '../src/db/index.js';
import { createScopedSql } from '../src/plugins/sql-scope.js';

test('cleanFilmTitle strips TrailerAddict RSS suffixes', () => {
  assert.equal(
    cleanFilmTitle('The Hunger Games: Sunrise on the Reaping: Trailer 3'),
    'The Hunger Games: Sunrise on the Reaping',
  );
  assert.equal(cleanFilmTitle('Werwulf: Trailer 2'), 'Werwulf');
  assert.equal(cleanFilmTitle('Dune: Part Three: Final Trailer'), 'Dune: Part Three');
  assert.equal(cleanFilmTitle('Example Movie Teaser Trailer'), 'Example Movie');
  assert.equal(cleanFilmTitle('Global Hit: Global Trailer'), 'Global Hit');
});

test('isPastRetention respects retention days from release date', () => {
  const release = '2026-09-01';
  assert.equal(isPastRetention(release, 7, '2026-09-07'), false);
  assert.equal(isPastRetention(release, 7, '2026-09-08'), true);
  assert.equal(isPastRetention(release, 7, '2026-09-15'), true);
  assert.equal(isPastRetention(null, 7, '2026-09-15'), false);
});

test('cleanupExpiredTrailers removes files and marks rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-cleanup-'));
  const db = openDatabase(path.join(dir, 't.sqlite'));
  runMigrations(createScopedSql(db, new Set(['trailer_downloads'])));
  const sql = createScopedSql(db, new Set(['trailer_downloads']));

  const keepFile = path.join(dir, 'keep.mp4');
  const removeFile = path.join(dir, 'remove.mp4');
  fs.writeFileSync(keepFile, 'keep');
  fs.writeFileSync(removeFile, 'remove');

  sql
    .prepare(
      `INSERT INTO trailer_downloads (guid, raw_title, film_title, traileraddict_url, release_date, file_path, downloaded_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run('g-keep', 'Keep: Trailer', 'Keep', 'http://example/keep', '2099-01-01', keepFile);
  sql
    .prepare(
      `INSERT INTO trailer_downloads (guid, raw_title, film_title, traileraddict_url, release_date, file_path, downloaded_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      'g-old',
      'Old: Trailer',
      'Old',
      'http://example/old',
      '2020-01-01',
      removeFile,
    );

  const fsMock = {
    exists: (p) => fs.existsSync(p),
    unlink: async (p) => {
      fs.unlinkSync(p);
    },
  };

  const service = new TrailerFetcherService({
    sql,
    fs: fsMock,
    fetchFn: async () => {
      throw new Error('network disabled in test');
    },
    trailerAddict: {
      fetchFeed: async () => [],
      fetchVideoUrl: async () => null,
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    getSettings: () => ({ retentionDaysAfterRelease: 7 }),
  });

  await service.cleanupExpiredTrailers();

  assert.equal(fs.existsSync(removeFile), false);
  assert.equal(fs.existsSync(keepFile), true);

  const removed = sql
    .prepare('SELECT removed_at FROM trailer_downloads WHERE guid = ?')
    .get('g-old');
  const kept = sql
    .prepare('SELECT removed_at FROM trailer_downloads WHERE guid = ?')
    .get('g-keep');
  assert.ok(removed.removed_at);
  assert.equal(kept.removed_at, null);

  db.close();
});

test('checkForNewTrailers downloads and inserts without network stubs failing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-poll-'));
  const downloadFolder = path.join(dir, 'trailers');
  const db = openDatabase(path.join(dir, 't.sqlite'));
  runMigrations(createScopedSql(db, new Set(['trailer_downloads'])));
  const sql = createScopedSql(db, new Set(['trailer_downloads']));

  const written = [];
  const fsMock = {
    mkdir: async (p) => {
      fs.mkdirSync(p, { recursive: true });
    },
    writeFile: async (p, data) => {
      written.push(p);
      fs.writeFileSync(p, data);
    },
    exists: () => false,
    unlink: async () => {},
  };

  const service = new TrailerFetcherService({
    sql,
    fs: fsMock,
    fetchFn: async (url) => ({
      ok: true,
      async arrayBuffer() {
        return new TextEncoder().encode(`video-bytes-${url}`).buffer;
      },
    }),
    trailerAddict: {
      fetchFeed: async () => [
        {
          guid: 'rss-1',
          title: 'Stub Film: Trailer 1',
          link: 'https://traileraddict.com/stub',
          pubDate: '',
        },
      ],
      fetchVideoUrl: async () => 'https://video.traileraddict.com/enc/stub.mp4',
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    getSettings: () => ({
      downloadFolder,
      certRegion: 'GB',
      tmdbApiKey: '',
    }),
  });

  await service.checkForNewTrailers();

  assert.equal(written.length, 1);
  assert.ok(fs.existsSync(written[0]));
  const row = sql.prepare('SELECT * FROM trailer_downloads WHERE guid = ?').get('rss-1');
  assert.equal(row.film_title, 'Stub Film');
  assert.equal(row.video_url, 'https://video.traileraddict.com/enc/stub.mp4');

  db.close();
});
