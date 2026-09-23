import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateManifest,
  isSafeArchivePath,
} from '../src/plugins/manifest.js';
import { parseGithubRepo } from '../src/plugins/manager.js';
import {
  ensureSecretKey,
  createSecrets,
  maskToken,
} from '../src/crypto/secrets.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPluginApi } from '../src/plugins/api.js';
import { EventBus } from '../src/events/bus.js';
import { openDatabase } from '../src/db/index.js';
import { createLogger } from '../src/log.js';
import { Scheduler } from '../src/plugins/runtime.js';

test('validateManifest accepts a valid plugin', () => {
  const result = validateManifest({
    id: 'netflix-rewatch',
    name: 'Netflix Rewatch',
    version: '1.0.0',
    apiVersion: 1,
    entry: 'plugin.js',
    permissions: ['plex.read', 'events.subscribe'],
  });
  assert.equal(result.ok, true);
});

test('validateManifest rejects bad apiVersion and path escape', () => {
  const badVersion = validateManifest({
    id: 'x',
    name: 'X',
    version: '1.0.0',
    apiVersion: 2,
    entry: 'plugin.js',
    permissions: [],
  });
  assert.equal(badVersion.ok, false);

  const badEntry = validateManifest({
    id: 'ok-plugin',
    name: 'Ok',
    version: '1.0.0',
    apiVersion: 1,
    entry: '../evil.js',
    permissions: [],
  });
  assert.equal(badEntry.ok, false);
});

test('isSafeArchivePath rejects traversal', () => {
  assert.equal(isSafeArchivePath('plugin.js'), true);
  assert.equal(isSafeArchivePath('../secret'), false);
  assert.equal(isSafeArchivePath('/etc/passwd'), false);
  assert.equal(isSafeArchivePath('C:\\Windows\\system32'), false);
});

test('parseGithubRepo accepts URL and short form', () => {
  assert.deepEqual(parseGithubRepo('https://github.com/acme/plex-toolkit-netflix-rewatch'), {
    owner: 'acme',
    repo: 'plex-toolkit-netflix-rewatch',
  });
  assert.deepEqual(parseGithubRepo('acme/foo'), { owner: 'acme', repo: 'foo' });
  assert.equal(parseGithubRepo('not a repo'), null);
});

test('secrets encrypt and decrypt round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-secret-'));
  const keyPath = path.join(dir, 'secret.key');
  const key = ensureSecretKey(keyPath);
  const secrets = createSecrets(key);
  const enc = secrets.encrypt('plex-token-value');
  assert.notEqual(enc, 'plex-token-value');
  assert.equal(secrets.decrypt(enc), 'plex-token-value');
  assert.ok(maskToken('abcdefghijklmnop').includes('…'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('plugin api denies missing permissions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-db-'));
  const db = openDatabase(path.join(dir, 't.sqlite'));
  const bus = new EventBus();
  const logger = createLogger(path.join(dir, 'logs'), db);
  const panels = new Map();
  const scheduler = new Scheduler(logger);
  const refreshed = [];
  const plex = {
    getLibraries: async () => [{ id: '1' }],
    refreshLibrary: async (sectionId) => {
      refreshed.push(String(sectionId));
      return { ok: true, sectionId: String(sectionId) };
    },
    markWatched: async () => {},
  };
  const api = createPluginApi({
    pluginId: 'test-plugin',
    permissions: ['plex.read'],
    plex,
    bus,
    db,
    logger,
    getConfiguredAccountId: () => '1',
    panels,
    scheduler,
  });

  const libs = await api.plex.getLibraries();
  assert.equal(libs.length, 1);
  await assert.rejects(() => api.plex.refreshLibrary('3'), /lacks permission/);
  await assert.rejects(() => api.plex.markWatched('1'), /lacks permission/);
  assert.throws(() => api.events.on('playback.started', () => {}), /lacks permission/);

  const apiRefresh = createPluginApi({
    pluginId: 'test-refresh',
    permissions: ['plex.refresh'],
    plex,
    bus,
    db,
    logger,
    getConfiguredAccountId: () => '1',
    panels,
    scheduler,
  });
  const refresh = await apiRefresh.plex.refreshLibrary('3');
  assert.equal(refresh.ok, true);
  assert.deepEqual(refreshed, ['3']);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
