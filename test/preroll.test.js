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
  selectFromGroups,
  stepGroupPositions,
  groupSteps,
  combinationKey,
  playbackSessionKey,
} from '../tools/preroll-scheduler/lib/selection.js';
import {
  parseStepsFromBody,
  formatSequence,
} from '../tools/preroll-scheduler/lib/ui.js';
import { PrerollService } from '../tools/preroll-scheduler/lib/service.js';
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
import { scanBucketFolder } from '../src/plugins/fs-media.js';
import { validateManifest } from '../src/plugins/manifest.js';
import {
  contentRatingForCertMatch,
  filterItemsByMovieCertificate,
} from '../tools/preroll-scheduler/lib/trailer-cert.js';
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
  assert.deepEqual(api.fs.listVideos(allowed), { entries: [], error: null });
  assert.throws(() => api.fs.listVideos(path.join(dir, 'other')), /outside/);
  db.close();
});

test('scanBucketFolder reports missing path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-scan-'));
  const missing = path.join(dir, 'nope');
  const result = scanBucketFolder(missing);
  assert.equal(result.entries.length, 0);
  assert.ok(result.error);
  assert.equal(result.error.code, 'ENOENT');
  assert.equal(result.error.path, path.resolve(missing));
});

test('scanBucketFolder reports non-directory path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-scan-file-'));
  const file = path.join(dir, 'not-a-dir.txt');
  fs.writeFileSync(file, 'x');
  const result = scanBucketFolder(file);
  assert.equal(result.entries.length, 0);
  assert.ok(result.error);
  assert.equal(result.error.code, 'ENOTDIR');
});

test('scanBucketFolder captures unreadable directory', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-scan-deny-'));
  const secret = path.join(dir, 'locked');
  fs.mkdirSync(secret);
  fs.chmodSync(secret, 0o000);
  try {
    const result = scanBucketFolder(secret);
    assert.equal(result.entries.length, 0);
    assert.ok(result.error);
    assert.equal(result.error.code, 'EACCES');
    assert.equal(result.error.path, path.resolve(secret));
  } finally {
    fs.chmodSync(secret, 0o700);
  }
});

test('contentRatingForCertMatch uses last movie on roll again', () => {
  assert.equal(
    contentRatingForCertMatch('roll_again', {
      lastMovieContentRating: 'gb/15',
    }),
    'gb/15',
  );
  assert.equal(
    contentRatingForCertMatch('tick', { lastMovieContentRating: 'gb/15' }),
    null,
  );
  assert.equal(
    contentRatingForCertMatch('playback', {
      movieContentRating: 'PG',
      lastMovieContentRating: '18',
    }),
    'PG',
  );
});

test('filterItemsByMovieCertificate keeps fetcher trailers matching feature cert', () => {
  const bucket = { folder_path: '/media/trailers' };
  const certByPath = new Map([
    [path.resolve('/media/trailers/a.mp4'), '15'],
    [path.resolve('/media/trailers/b.mp4'), 'PG'],
  ]);
  const items = [
    { id: 1, relative_path: 'a.mp4', enabled: 1, missing: 0 },
    { id: 2, relative_path: 'b.mp4', enabled: 1, missing: 0 },
    { id: 3, relative_path: 'manual.mp4', enabled: 1, missing: 0 },
  ];
  const result = filterItemsByMovieCertificate(items, bucket, certByPath, '15');
  assert.equal(result.filtered, true);
  assert.deepEqual(result.items.map((i) => i.id), [1, 3]);
});

test('filterItemsByMovieCertificate falls back when no cert match', () => {
  const bucket = { folder_path: '/media/trailers' };
  const certByPath = new Map([[path.resolve('/media/trailers/b.mp4'), 'PG']]);
  const items = [{ id: 2, relative_path: 'b.mp4', enabled: 1, missing: 0 }];
  const result = filterItemsByMovieCertificate(items, bucket, certByPath, '18');
  assert.equal(result.fallback, true);
  assert.equal(result.items.length, 1);
});

function stepBody(rows) {
  return {
    step_join: rows.map((r) => r[0]),
    step_bucket: rows.map((r) => String(r[1])),
    step_count: rows.map(() => '1'),
  };
}

function groupsOf(steps) {
  const positions = stepGroupPositions(steps);
  return groupSteps(
    steps.map((s, i) => ({ ...s, group_position: positions[i] })),
  ).map((g) => g.map((s) => s.bucketId));
}

test('parseStepsFromBody: 1 and (2 or 3)', () => {
  const steps = parseStepsFromBody(
    stepBody([
      ['and', 1],
      ['and', 2],
      ['or', 3],
    ]),
  );
  assert.deepEqual(groupsOf(steps), [[1], [2, 3]]);
});

test('parseStepsFromBody: (1 and 2) and (3 or 4)', () => {
  const steps = parseStepsFromBody(
    stepBody([
      ['and', 1],
      ['and', 2],
      ['and', 3],
      ['or', 4],
    ]),
  );
  assert.deepEqual(groupsOf(steps), [[1], [2], [3, 4]]);
});

test('parseStepsFromBody: 1 or 2, and first-row join is ignored', () => {
  const steps = parseStepsFromBody(
    stepBody([
      ['or', 1],
      ['or', 2],
    ]),
  );
  assert.deepEqual(groupsOf(steps), [[1, 2]]);
});

test('parseStepsFromBody: consecutive ors are one group', () => {
  const steps = parseStepsFromBody(
    stepBody([
      ['and', 1],
      ['or', 2],
      ['or', 3],
      ['and', 4],
    ]),
  );
  assert.deepEqual(groupsOf(steps), [[1, 2, 3], [4]]);
});

test('parseStepsFromBody without joins keeps every step as its own group', () => {
  const steps = parseStepsFromBody({
    step_bucket: ['1', '2'],
    step_count: ['1', '1'],
  });
  assert.deepEqual(groupsOf(steps), [[1], [2]]);
});

test('formatSequence brackets ORs only beside other groups', () => {
  const step = (id, g) => ({
    bucket_id: id,
    bucket_name: `B${id}`,
    count: 1,
    group_position: g,
  });
  assert.equal(
    formatSequence([step(1, 0), step(2, 1), step(3, 1)]),
    '1× B1 and (1× B2 or 1× B3)',
  );
  assert.equal(formatSequence([step(1, 0), step(2, 0)]), '1× B1 or 1× B2');
  assert.equal(formatSequence([step(1, 0), step(2, 1)]), '1× B1 and 1× B2');
});

function bucketItems(bucketId, ids) {
  return ids.map((id) => ({ id, bucketId, enabled: 1, missing: 0 }));
}

function alt(bucketId, ids, extra = {}) {
  return {
    bucketId,
    bucketName: `B${bucketId}`,
    count: 1,
    items: bucketItems(bucketId, ids),
    usedIds: [],
    ...extra,
  };
}

test('selectFromGroups always plays AND groups and exactly one OR branch', () => {
  for (let n = 0; n < 20; n++) {
    const { picks } = selectFromGroups(
      [[alt(1, [10])], [alt(2, [20]), alt(3, [30])]],
      'random',
    );
    assert.equal(picks.length, 2);
    assert.equal(picks[0].alternative.bucketId, 1);
    assert.ok([2, 3].includes(picks[1].alternative.bucketId));
    assert.equal(picks[1].selected.length, 1);
  }
});

test('selectFromGroups falls through an empty OR branch', () => {
  for (let n = 0; n < 20; n++) {
    const { picks, warnings } = selectFromGroups(
      [[alt(1, []), alt(2, [20])]],
      'random',
    );
    assert.equal(picks.length, 1);
    assert.equal(picks[0].alternative.bucketId, 2);
    assert.deepEqual(warnings, []);
  }
});

test('selectFromGroups warns when no OR branch can play', () => {
  const { picks, warnings } = selectFromGroups(
    [[alt(1, []), alt(2, [])]],
    'random',
  );
  assert.equal(picks.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /B1 \/ B2/);
});

test('selectFromGroups prefers certificate-matched OR branches', () => {
  for (let n = 0; n < 20; n++) {
    const { picks } = selectFromGroups(
      [[alt(1, [10], { certFallback: true }), alt(2, [20])]],
      'random',
    );
    assert.equal(picks[0].alternative.bucketId, 2);
  }
});

test('selectFromGroups only returns history for the chosen branch', () => {
  const { picks } = selectFromGroups(
    [[alt(1, [10, 11]), alt(2, [20, 21])]],
    'random_avoid_repeats',
    { random: () => 0 },
  );
  assert.equal(picks.length, 1);
  const chosen = picks[0].alternative.bucketId;
  const ids = chosen === 1 ? [10, 11] : [20, 21];
  assert.ok(picks[0].nextUsedIds.every((id) => ids.includes(id)));
});

test('selectFromGroups carries avoid-repeats history across steps sharing a bucket', () => {
  const { picks } = selectFromGroups(
    [[alt(1, [10, 11])], [alt(1, [10, 11])]],
    'random_avoid_repeats',
    { random: () => 0 },
  );
  assert.equal(picks.length, 2);
  assert.notEqual(picks[0].selected[0].id, picks[1].selected[0].id);
});

test('replaceSteps stores OR groups and listSteps orders them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-steps-'));
  const db = openDatabase(path.join(dir, 't.sqlite'));
  const service = new PrerollService({
    sql: createScopedSql(db),
    fs: {},
    plex: { isConfigured: () => false },
    log: { info() {}, warn() {}, error() {} },
  });
  const bucket = (name) => ({
    id: Number(
      db
        .prepare(
          'INSERT INTO preroll_buckets (name, folder_path) VALUES (?, ?)',
        )
        .run(name, `/prerolls/${name}`).lastInsertRowid,
    ),
  });
  const a = bucket('A');
  const b = bucket('B');
  const c = bucket('C');
  const schedule = service.createSchedule({
    name: 'Default',
    steps: parseStepsFromBody(
      stepBody([
        ['and', a.id],
        ['and', b.id],
        ['or', c.id],
      ]),
    ),
  });
  const steps = service.listSteps(schedule.id);
  assert.deepEqual(
    steps.map((s) => [s.bucket_id, s.group_position]),
    [
      [a.id, 0],
      [b.id, 1],
      [c.id, 1],
    ],
  );
  assert.equal(formatSequence(steps), '1× A and (1× B or 1× C)');
  db.close();
});
