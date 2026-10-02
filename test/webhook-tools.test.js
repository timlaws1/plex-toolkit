import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDatabase } from '../src/db/index.js';
import { createLogger } from '../src/log.js';
import { EventBus } from '../src/events/bus.js';
import { PlexEventMonitor } from '../src/plex/events.js';
import { InProcessRuntime, Scheduler } from '../src/plugins/runtime.js';
import { mountPlexWebhook } from '../src/http/webhook.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = '123';
const TOKEN = 'c'.repeat(48);
const TOOLS = ['netflix-rewatch', 'preroll-scheduler', 'scheduled-recommendations'];

const METADATA = {
  55: {
    ratingKey: '55',
    type: 'episode',
    title: 'Ep 2',
    grandparentTitle: 'Show',
    grandparentRatingKey: 'show-1',
    parentIndex: 1,
    index: 2,
    librarySectionID: '1',
    viewCount: 1,
    duration: 1000,
  },
  700: { ratingKey: '700', type: 'movie', title: 'Film', viewCount: 0, duration: 1000 },
};

/** Records every Plex call a tool or the session tracker makes. */
function recordingPlex(calls) {
  const impl = {
    getMetadata: (key) => METADATA[key] || null,
    getEpisodes: () => [],
    getLibraries: () => [],
  };
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        if (prop === 'clientId') return 'test';
        if (prop === 'isConfigured') return () => true;
        if (prop === 'websocketUrl') return () => null;
        return async (...args) => {
          calls.push([prop, ...args]);
          return impl[prop] ? impl[prop](...args) : null;
        };
      },
    },
  );
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-wh-tools-'));
  const db = openDatabase(path.join(dir, 't.sqlite'));
  const logger = createLogger(path.join(dir, 'logs'), db);
  const bus = new EventBus();
  const calls = [];
  const plex = recordingPlex(calls);
  const scheduler = new Scheduler(logger);
  const runtime = new InProcessRuntime({
    plex,
    bus,
    db,
    logger,
    getConfiguredAccountId: () => OWNER,
    panels: new Map(),
    scheduler,
  });

  for (const id of TOOLS) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', id, 'plugin.json'), 'utf8'));
    db.prepare(
      `INSERT INTO plugins (id, name, version, source_type, enabled, permissions)
       VALUES (?, ?, ?, 'bundled', 1, ?)`,
    ).run(id, manifest.name, manifest.version, JSON.stringify(manifest.permissions));
  }
  db.prepare(
    `INSERT INTO plugin_settings (plugin_id, key, value) VALUES ('netflix-rewatch', 'libraries', '["1"]')`,
  ).run();
  const schedule = db
    .prepare(
      `INSERT INTO rec_schedules (name, output_type, plex_destination_id, replace_on_watch)
       VALUES ('Weekly', 'collection', 'col-1', 0)`,
    )
    .run();
  db.prepare(
    `INSERT INTO rec_items (schedule_id, position, title, plex_rating_key, active)
     VALUES (?, 1, 'Picked film', '900', 1)`,
  ).run(schedule.lastInsertRowid);

  for (const id of TOOLS) {
    const record = db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
    await runtime.activate(record, path.join(ROOT, 'tools', id));
  }

  const eventMonitor = new PlexEventMonitor({
    plex,
    bus,
    logger,
    getConfiguredAccountId: () => OWNER,
  });
  const app = express();
  mountPlexWebhook(app, { token: TOKEN, eventMonitor, logger });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/webhooks/plex/${TOKEN}`;

  await settle();
  calls.length = 0;

  return {
    db,
    calls,
    async send(payload) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 204);
    },
    toolLog(pluginId, pattern) {
      return db
        .prepare('SELECT message FROM plugin_activity WHERE plugin_id = ?')
        .all(pluginId)
        .some((row) => pattern.test(row.message));
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      for (const id of TOOLS) await runtime.deactivate(id);
      scheduler.clearAll();
      db.close();
    },
  };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/** Playback that each tool acts on when it comes from the configured account. */
function playbackSequence(account) {
  return [
    { event: 'media.play', Account: account, Metadata: { ratingKey: '55', type: 'episode', viewOffset: 0 } },
    { event: 'media.stop', Account: account, Metadata: { ratingKey: '55', type: 'episode', viewOffset: 950 } },
    { event: 'media.play', Account: account, Metadata: { ratingKey: '700', type: 'movie', viewOffset: 0 } },
    { event: 'media.scrobble', Account: account, Metadata: { ratingKey: '900', type: 'movie' } },
  ];
}

test('a forged webhook does not reach Netflix Rewatch, Preroll Scheduler, or Scheduled Recommendations', async () => {
  const ctx = await setup();
  try {
    for (const account of [undefined, { id: 999 }, { id: 0 }]) {
      for (const payload of playbackSequence(account)) {
        await ctx.send(payload);
      }
    }
    await settle();

    assert.deepEqual(ctx.calls, []);
    assert.equal(ctx.toolLog('preroll-scheduler', /regenerating after movie start/), false);
    assert.equal(ctx.toolLog('scheduled-recommendations', /Watched recommendation/), false);
    assert.equal(
      ctx.db.prepare("SELECT active FROM rec_items WHERE plex_rating_key = '900'").get().active,
      1,
    );

    for (const payload of playbackSequence({ id: Number(OWNER) })) {
      await ctx.send(payload);
      await settle();
    }

    const names = ctx.calls.map(([name]) => name);
    assert.ok(names.includes('getMetadata'), 'the owner session fetches metadata');
    assert.deepEqual(
      ctx.calls.find(([name]) => name === 'getEpisodes'),
      ['getEpisodes', 'show-1'],
      'Netflix Rewatch acts on the owner replaying a watched episode',
    );
    assert.equal(ctx.toolLog('preroll-scheduler', /regenerating after movie start/), true);
    assert.deepEqual(
      ctx.calls.find(([name]) => name === 'removeCollectionItem'),
      ['removeCollectionItem', 'col-1', '900'],
      'Scheduled Recommendations removes the watched pick',
    );
  } finally {
    await ctx.close();
  }
});
