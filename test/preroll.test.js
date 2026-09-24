import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  resolveActiveSchedule,
  scheduleMatches,
  dateSpanDays,
} from '../tools/preroll-scheduler/lib/schedule.js';
import {
  selectFromBucket,
  combinationKey,
  playbackSessionKey,
} from '../tools/preroll-scheduler/lib/selection.js';
import {
  toPlexPath,
  buildPlexPrerollValue,
  isPathUnderRoots,
} from '../tools/preroll-scheduler/lib/paths.js';
import {
  assertPathAllowed,
  parseMediaRoots,
} from '../src/plugins/fs-scope.js';
import {
  assertSqlTablesAllowed,
  createScopedSql,
  extractSqlTableNames,
} from '../src/plugins/sql-scope.js';
import { createPluginApi } from '../src/plugins/api.js';
import { validateManifest } from '../src/plugins/manifest.js';
import { openDatabase } from '../src/db/index.js';
import { createLogger } from '../src/log.js';
import { EventBus } from '../src/events/bus.js';
import { Scheduler } from '../src/plugins/runtime.js';

function sched(partial) {
  return {
    id: 1,
    name: 'S',
    enabled: 1,
    start_date: null,
    end_date: null,
    start_time: null,
    end_time: null,
    ...partial,
  };
}

test('default schedule matches any day', () => {
  const s = sched({ id: 1, name: 'Normal' });
  assert.equal(scheduleMatches(s, new Date(2026, 9, 15)), true);
});

test('Halloween date range matches only in October', () => {
  const s = sched({
    id: 2,
    name: 'Halloween',
    start_date: '2026-10-01',
    end_date: '2026-10-31',
  });
  assert.equal(scheduleMatches(s, new Date(2026, 9, 15)), true);
  assert.equal(scheduleMatches(s, new Date(2026, 10, 1)), false);
  assert.equal(scheduleMatches(s, new Date(2026, 8, 30)), false);
});

test('yearly Halloween matches October in later years', () => {
  const s = sched({
    id: 2,
    name: 'Halloween',
    start_date: '2026-10-01',
    end_date: '2026-10-31',
    repeat_yearly: 1,
  });
  assert.equal(scheduleMatches(s, new Date(2027, 9, 15)), true);
  assert.equal(scheduleMatches(s, new Date(2027, 8, 30)), false);
  assert.equal(scheduleMatches(s, new Date(2027, 10, 1)), false);
});

test('yearly off still requires the calendar year', () => {
  const s = sched({
    start_date: '2026-10-01',
    end_date: '2026-10-31',
    repeat_yearly: 0,
  });
  assert.equal(scheduleMatches(s, new Date(2026, 9, 15)), true);
  assert.equal(scheduleMatches(s, new Date(2027, 9, 15)), false);
});

test('yearly Christmas wrap matches Dec and Jan but not mid-year', () => {
  const s = sched({
    id: 3,
    name: 'Christmas',
    start_date: '2026-12-20',
    end_date: '2027-01-05',
    repeat_yearly: 1,
  });
  assert.equal(scheduleMatches(s, new Date(2027, 11, 25)), true);
  assert.equal(scheduleMatches(s, new Date(2028, 0, 3)), true);
  assert.equal(scheduleMatches(s, new Date(2027, 5, 15)), false);
  assert.equal(dateSpanDays(s), 17); // Dec 20–31 (12) + Jan 1–5 (5)
});

test('shorter yearly window beats default when both match', () => {
  const normal = sched({ id: 1, name: 'Normal' });
  const halloween = sched({
    id: 2,
    name: 'Halloween',
    start_date: '2026-10-01',
    end_date: '2026-10-31',
    repeat_yearly: 1,
  });
  const active = resolveActiveSchedule(
    [normal, halloween],
    new Date(2028, 9, 15),
  );
  assert.equal(active.name, 'Halloween');
});

test('optional time window is inclusive without overnight wrap', () => {
  const s = sched({
    start_time: '18:00',
    end_time: '22:00',
  });
  assert.equal(scheduleMatches(s, new Date(2026, 0, 1, 17, 59)), false);
  assert.equal(scheduleMatches(s, new Date(2026, 0, 1, 18, 0)), true);
  assert.equal(scheduleMatches(s, new Date(2026, 0, 1, 22, 0)), true);
  assert.equal(scheduleMatches(s, new Date(2026, 0, 1, 22, 1)), false);
});

test('disabled schedule never matches', () => {
  assert.equal(
    scheduleMatches(sched({ enabled: 0 }), new Date(2026, 0, 1)),
    false,
  );
});

test('dated schedule beats default when both match', () => {
  const normal = sched({ id: 1, name: 'Normal' });
  const halloween = sched({
    id: 2,
    name: 'Halloween',
    start_date: '2026-10-01',
    end_date: '2026-10-31',
  });
  const active = resolveActiveSchedule(
    [normal, halloween],
    new Date(2026, 9, 15),
  );
  assert.equal(active.name, 'Halloween');
});

test('shorter date span wins over longer overlapping span', () => {
  const long = sched({
    id: 1,
    name: 'Autumn',
    start_date: '2026-09-01',
    end_date: '2026-11-30',
  });
  const short = sched({
    id: 2,
    name: 'Halloween',
    start_date: '2026-10-01',
    end_date: '2026-10-31',
  });
  assert.ok(dateSpanDays(short) < dateSpanDays(long));
  const active = resolveActiveSchedule([long, short], new Date(2026, 9, 15));
  assert.equal(active.name, 'Halloween');
});

test('equal spans prefer later start date then lower id', () => {
  const a = sched({
    id: 10,
    name: 'A',
    start_date: '2026-10-01',
    end_date: '2026-10-31',
  });
  const b = sched({
    id: 5,
    name: 'B',
    start_date: '2026-10-01',
    end_date: '2026-10-31',
  });
  assert.equal(
    resolveActiveSchedule([a, b], new Date(2026, 9, 15)).id,
    5,
  );
});

test('random avoid repeats cycles through all items before reuse', () => {
  const items = [1, 2, 3].map((id) => ({ id, enabled: 1, missing: 0 }));
  const seq = [];
  let used = [];
  let i = 0;
  const values = [0.1, 0.5, 0.9, 0.2, 0.6, 0.8];
  const random = () => values[i++ % values.length];

  for (let n = 0; n < 3; n++) {
    const r = selectFromBucket(items, 1, 'random_avoid_repeats', used, {
      random,
    });
    assert.equal(r.selected.length, 1);
    seq.push(r.selected[0].id);
    used = r.nextUsedIds;
  }
  assert.deepEqual(new Set(seq), new Set([1, 2, 3]));

  const again = selectFromBucket(items, 1, 'random_avoid_repeats', used, {
    random,
  });
  assert.equal(again.selected.length, 1);
  assert.ok([1, 2, 3].includes(again.selected[0].id));
});

test('combinationKey is stable ordered ids', () => {
  assert.equal(combinationKey([{ id: 3 }, { id: 7 }]), '3,7');
});

test('playbackSessionKey matches SessionTracker shape', () => {
  assert.equal(
    playbackSessionKey({
      accountId: '99',
      sessionKey: 'abc',
      ratingKey: '1',
    }),
    '99:abc',
  );
  assert.equal(playbackSessionKey({ ratingKey: '42' }), '0:42');
});

test('buildPlexPrerollValue joins with commas for sequential play', () => {
  assert.equal(
    buildPlexPrerollValue(['/a/ident.mp4', '/b/trailer.mp4']),
    '/a/ident.mp4,/b/trailer.mp4',
  );
  assert.equal(buildPlexPrerollValue([]), '');
});

test('toPlexPath rewrites toolkit prefix to plex prefix', () => {
  const local = path.join('/prerolls', 'idents', 'a.mp4');
  const plex = toPlexPath(local, {
    toolkitPrefix: '/prerolls',
    plexPrefix: 'D:\\Plex\\prerolls',
  });
  assert.match(plex, /idents/);
  assert.match(plex, /a\.mp4/);
  assert.ok(plex.startsWith('D:'));
});

test('toPlexPath leaves path unchanged without prefixes', () => {
  assert.equal(toPlexPath('/media/x.mp4', {}), '/media/x.mp4');
});

test('isPathUnderRoots rejects paths outside buckets', () => {
  const root = path.resolve('/prerolls/idents');
  assert.equal(isPathUnderRoots(path.join(root, 'a.mp4'), [root]), true);
  assert.equal(isPathUnderRoots(path.resolve('/other/a.mp4'), [root]), false);
});

test('parseMediaRoots and assertPathAllowed', () => {
  assert.equal(parseMediaRoots(''), null);
  assert.equal(parseMediaRoots(null), null);
  const roots = parseMediaRoots('/prerolls;/media');
  assert.equal(roots.length, 2);
  assert.equal(
    assertPathAllowed(path.join('/prerolls', 'a.mp4'), roots),
    path.resolve('/prerolls', 'a.mp4'),
  );
  assert.throws(() => assertPathAllowed('/etc/passwd', roots), /outside/);
  assert.equal(assertPathAllowed('/any/path', null), path.resolve('/any/path'));
});

test('sql scope extracts tables and rejects disallowed', () => {
  assert.deepEqual(
    extractSqlTableNames(
      'SELECT b.*, (SELECT COUNT(*) FROM preroll_items i WHERE i.bucket_id = b.id) FROM preroll_buckets b',
    ).sort(),
    ['preroll_buckets', 'preroll_items'],
  );
  assert.doesNotThrow(() =>
    assertSqlTablesAllowed('SELECT * FROM preroll_state WHERE id = 1'),
  );
  assert.throws(
    () => assertSqlTablesAllowed('SELECT * FROM plex_servers'),
    /disallowed/,
  );
  // Bucket scan upsert — must not treat "SET" as a table
  assert.deepEqual(
    extractSqlTableNames(`
      INSERT INTO preroll_items (bucket_id, filename)
      VALUES (?, ?)
      ON CONFLICT(bucket_id, relative_path) DO UPDATE SET
        filename = excluded.filename,
        missing = 0
    `),
    ['preroll_items'],
  );
  assert.doesNotThrow(() =>
    assertSqlTablesAllowed(`
      INSERT INTO preroll_items (bucket_id, filename)
      VALUES (?, ?)
      ON CONFLICT(bucket_id, relative_path) DO UPDATE SET filename = excluded.filename
    `),
  );
});

test('createScopedSql allows preroll prepare and blocks others', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sql-'));
  const db = openDatabase(path.join(dir, 't.sqlite'));
  const sql = createScopedSql(db);
  sql.prepare('SELECT id FROM preroll_state WHERE id = 1').get();
  assert.throws(() => sql.prepare('SELECT * FROM sessions'), /disallowed/);
  db.close();
});

test('validateManifest accepts preroll permissions', () => {
  const result = validateManifest({
    id: 'preroll-scheduler',
    name: 'Preroll',
    version: '1.0.0',
    apiVersion: 1,
    entry: 'plugin.js',
    permissions: [
      'plex.prefs',
      'fs.read',
      'sql.preroll',
      'events.subscribe',
      'scheduler',
    ],
  });
  assert.equal(result.ok, true);
});

test('plugin api denies prefs fs and sql without permissions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-deny-'));
  const db = openDatabase(path.join(dir, 't.sqlite'));
  const log = createLogger(path.join(dir, 'logs'), db);
  const api = createPluginApi({
    pluginId: 'x',
    permissions: [],
    plex: {
      getPreference: async () => null,
      setPreference: async () => {},
      isConfigured: () => false,
    },
    bus: new EventBus(),
    db,
    logger: log,
    getConfiguredAccountId: () => null,
    panels: new Map(),
    scheduler: new Scheduler(log),
    mediaRoots: [path.resolve('/prerolls')],
  });
  await assert.rejects(
    () => api.plex.getPreference('CinemaTrailersPrerollID'),
    /lacks permission/,
  );
  assert.throws(() => api.fs.listVideos('/prerolls'), /lacks permission/);
  assert.throws(
    () => api.sql.prepare('SELECT 1 FROM preroll_state'),
    /lacks permission/,
  );
  db.close();
});

test('plugin api fs.read enforces media roots', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-fs-'));
  const allowed = path.join(dir, 'media');
  fs.mkdirSync(allowed);
  const db = openDatabase(path.join(dir, 't.sqlite'));
  const log = createLogger(path.join(dir, 'logs'), db);
  const api = createPluginApi({
    pluginId: 'x',
    permissions: ['fs.read'],
    plex: { isConfigured: () => false },
    bus: new EventBus(),
    db,
    logger: log,
    getConfiguredAccountId: () => null,
    panels: new Map(),
    scheduler: new Scheduler(log),
    mediaRoots: [allowed],
  });
  assert.deepEqual(api.fs.listVideos(allowed), []);
  assert.throws(() => api.fs.listVideos(path.join(dir, 'other')), /outside/);
  db.close();
});
