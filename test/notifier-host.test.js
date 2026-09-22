import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapPeople,
  mapGuids,
  mapMetadata,
  mapLibraryItem,
} from '../src/plex/client.js';
import { validateManifest } from '../src/plugins/manifest.js';
import { createPluginApi } from '../src/plugins/api.js';
import { EventBus } from '../src/events/bus.js';
import { openDatabase } from '../src/db/index.js';
import { createLogger } from '../src/log.js';
import { Scheduler } from '../src/plugins/runtime.js';
import { createSecrets, ensureSecretKey } from '../src/crypto/secrets.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('mapGuids and mapPeople extract Plex metadata fields', () => {
  assert.deepEqual(mapGuids([{ id: 'tmdb://123' }, 'imdb://tt456']), [
    'tmdb://123',
    'imdb://tt456',
  ]);
  assert.deepEqual(mapPeople([{ tag: 'Gary Oldman', role: 'Jackson Lamb', id: 1 }]), [
    { id: '1', tag: 'Gary Oldman', role: 'Jackson Lamb', thumb: null },
  ]);
});

test('mapMetadata includes cast crew genres and guids', () => {
  const meta = mapMetadata({
    ratingKey: '99',
    type: 'movie',
    title: 'Slow Horses',
    year: 2022,
    viewCount: 3,
    Guid: [{ id: 'tmdb://movie/1' }],
    Role: [{ tag: 'A' }],
    Director: [{ tag: 'B' }],
    Writer: [{ tag: 'C' }],
    Genre: [{ tag: 'Spy' }],
  });
  assert.equal(meta.viewCount, 3);
  assert.equal(meta.roles[0].tag, 'A');
  assert.equal(meta.directors[0].tag, 'B');
  assert.equal(meta.writers[0].tag, 'C');
  assert.deepEqual(meta.genres, ['Spy']);
  assert.deepEqual(meta.guids, ['tmdb://movie/1']);
});

test('mapLibraryItem preserves view counts', () => {
  const item = mapLibraryItem(
    {
      ratingKey: '1',
      type: 'movie',
      title: 'X',
      viewCount: 5,
      Guid: ['imdb://tt1'],
    },
    '2',
  );
  assert.equal(item.viewCount, 5);
  assert.equal(item.librarySectionID, '2');
});

test('validateManifest accepts plex.discover and mail.send', () => {
  const result = validateManifest({
    id: 'plex-notifier',
    name: 'Plex Notifier',
    version: '1.0.0',
    apiVersion: 1,
    entry: 'plugin.js',
    permissions: ['plex.read', 'plex.discover', 'mail.send', 'storage', 'scheduler'],
  });
  assert.equal(result.ok, true);
});

test('plugin api exposes discover and mail behind permissions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-api-'));
  const db = openDatabase(path.join(dir, 't.sqlite'));
  const bus = new EventBus();
  const logger = createLogger(path.join(dir, 'logs'), db);
  const panels = new Map();
  const scheduler = new Scheduler(logger);
  const key = ensureSecretKey(path.join(dir, 'secret.key'));
  const secrets = createSecrets(key);

  const plex = {
    getLibraries: async () => [],
    getLibraryItems: async () => ({ items: [], total: 0 }),
    getWatchlist: async () => [{ title: 'A' }],
    searchDiscover: async () => [],
    getDiscoverMetadata: async () => null,
  };

  const api = createPluginApi({
    pluginId: 'plex-notifier',
    permissions: ['plex.read', 'plex.discover', 'mail.send', 'storage'],
    plex,
    bus,
    db,
    logger,
    getConfiguredAccountId: () => '1',
    panels,
    scheduler,
    secrets,
    settingsSchema: [
      { key: 'smtpHost', type: 'string' },
      { key: 'smtpPassword', type: 'secret' },
      { key: 'smtpFrom', type: 'string' },
      { key: 'smtpTo', type: 'string' },
    ],
  });

  const page = await api.plex.getLibraryItems('1', { type: 1 });
  assert.equal(page.total, 0);
  const wl = await api.plex.getWatchlist();
  assert.equal(wl.length, 1);

  const denied = createPluginApi({
    pluginId: 'x',
    permissions: ['plex.read'],
    plex,
    bus,
    db,
    logger,
    getConfiguredAccountId: () => '1',
    panels,
    scheduler,
  });
  await assert.rejects(() => denied.plex.getWatchlist(), /lacks permission/);
  await assert.rejects(() => denied.mail.send({ subject: 'x' }), /lacks permission/);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
