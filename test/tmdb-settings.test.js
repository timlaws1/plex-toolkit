import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/index.js';
import { createSecrets } from '../src/crypto/secrets.js';
import { createLogger } from '../src/log.js';
import { EventBus } from '../src/events/bus.js';
import { createPluginApi } from '../src/plugins/api.js';
import { validateManifest } from '../src/plugins/manifest.js';
import { Scheduler } from '../src/plugins/runtime.js';
import {
  loadTmdbSettings,
  migrateLegacyTmdb,
  saveTmdbSettings,
  tmdbConfigured,
} from '../src/tmdb/settings.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-tmdb-'));
  const db = openDatabase(path.join(dir, 't.sqlite'));
  const secrets = createSecrets(crypto.randomBytes(32));
  return { db, secrets, dir };
}

function teardown({ db, dir }) {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('tmdb key is kept when saved blank and removed when cleared', () => {
  const env = setup();
  const { db, secrets } = env;
  assert.equal(tmdbConfigured(loadTmdbSettings(db, secrets)), false);
  saveTmdbSettings(db, secrets, { apiKey: ' abc123 ' });
  assert.equal(loadTmdbSettings(db, secrets).apiKey, 'abc123');
  saveTmdbSettings(db, secrets, { apiKey: '' });
  assert.equal(loadTmdbSettings(db, secrets).apiKey, 'abc123');
  saveTmdbSettings(db, secrets, { apiKey: '', clear: '1' });
  assert.equal(tmdbConfigured(loadTmdbSettings(db, secrets)), false);
  teardown(env);
});

test('a tool TMDb key is copied to the shared setting once', () => {
  const env = setup();
  const { db, secrets } = env;
  const addPlugin = db.prepare(
    `INSERT INTO plugins (id, name, version, source_type) VALUES (?, ?, '1.0.0', 'bundled')`,
  );
  addPlugin.run('plex-notifier', 'Plex Notifier');
  addPlugin.run('trailer-fetcher', 'Trailer Fetcher');
  const insert = db.prepare('INSERT INTO plugin_settings (plugin_id, key, value) VALUES (?, ?, ?)');
  insert.run('plex-notifier', 'tmdbApiKey', JSON.stringify(''));
  insert.run('trailer-fetcher', 'tmdbApiKey', JSON.stringify(secrets.encrypt('from-trailers')));

  assert.equal(migrateLegacyTmdb(db, secrets), true);
  assert.equal(loadTmdbSettings(db, secrets).apiKey, 'from-trailers');
  assert.equal(migrateLegacyTmdb(db, secrets), false);
  teardown(env);
});

test('ctx.tmdb exposes the shared key behind the tmdb permission', () => {
  const env = setup();
  const { db, secrets, dir } = env;
  saveTmdbSettings(db, secrets, { apiKey: 'shared-key' });
  assert.equal(
    validateManifest({ id: 'demo-tool', name: 'Demo', version: '1.0.0', apiVersion: 1, permissions: ['tmdb'] }).ok,
    true,
  );

  const logger = createLogger(path.join(dir, 'logs'), db);
  const base = {
    plex: {},
    bus: new EventBus(),
    db,
    logger,
    getConfiguredAccountId: () => '1',
    panels: new Map(),
    scheduler: new Scheduler(logger),
    secrets,
  };
  const allowed = createPluginApi({ ...base, pluginId: 'demo-tool', permissions: ['tmdb'] });
  assert.equal(allowed.tmdb.apiKey(), 'shared-key');
  assert.equal(allowed.tmdb.isConfigured(), true);

  const denied = createPluginApi({ ...base, pluginId: 'other-tool', permissions: [] });
  assert.throws(() => denied.tmdb.apiKey(), /lacks permission/);
  teardown(env);
});
