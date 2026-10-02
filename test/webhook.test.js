import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createLogger } from '../src/log.js';
import { EventBus } from '../src/events/bus.js';
import { PlexEventMonitor } from '../src/plex/events.js';
import { createPluginApi } from '../src/plugins/api.js';
import { Scheduler } from '../src/plugins/runtime.js';
import { createSecrets, ensureSecretKey } from '../src/crypto/secrets.js';
import { ensureWebhookToken } from '../src/plex/auth.js';
import { createApp } from '../src/http/app.js';
import { webhookTokenMatches, isPlexNotification } from '../src/http/webhook.js';

const OWNER = '123';
const TOKEN = 'a'.repeat(48);

async function setup({ configured = OWNER } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-webhook-'));
  const db = openDatabase(path.join(dir, 't.sqlite'));
  const logger = createLogger(path.join(dir, 'logs'), db);
  const secrets = createSecrets(ensureSecretKey(path.join(dir, 'secret.key')));
  const bus = new EventBus();
  const metadataCalls = [];
  const plex = {
    clientId: 'test',
    isConfigured: () => true,
    getMetadata: async (ratingKey) => {
      metadataCalls.push(ratingKey);
      return { ratingKey, type: 'episode', title: 'Ep', viewCount: 1, duration: 1000 };
    },
  };
  const eventMonitor = new PlexEventMonitor({
    plex,
    bus,
    logger,
    getConfiguredAccountId: () => configured,
  });
  const app = createApp({
    db,
    secrets,
    plex,
    pluginManager: { listInstalled: () => [], runtime: { getModule: () => null } },
    eventMonitor,
    panels: new Map(),
    logger,
    publicUrl: '',
    webhookToken: TOKEN,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = createPluginApi({
    pluginId: 'listener',
    permissions: ['events.subscribe'],
    plex,
    bus,
    db,
    logger,
    getConfiguredAccountId: () => configured,
    panels: new Map(),
    scheduler: new Scheduler(logger),
  });
  const received = [];
  for (const name of ['playback.started', 'playback.progress', 'episode.watched', 'movie.watched']) {
    api.events.on(name, (payload) => received.push({ name, payload }));
  }

  return {
    base,
    bus,
    eventMonitor,
    metadataCalls,
    received,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

function playPayload(overrides = {}) {
  return {
    event: 'media.play',
    Account: { id: Number(OWNER) },
    Player: { uuid: 'player-1' },
    Metadata: { ratingKey: '55', type: 'episode', viewOffset: 0 },
    ...overrides,
  };
}

test('webhookTokenMatches requires an exact, non-empty match', () => {
  assert.equal(webhookTokenMatches(TOKEN, TOKEN), true);
  assert.equal(webhookTokenMatches(`${TOKEN}x`, TOKEN), false);
  assert.equal(webhookTokenMatches('b'.repeat(48), TOKEN), false);
  assert.equal(webhookTokenMatches('', ''), false);
  assert.equal(webhookTokenMatches(undefined, TOKEN), false);
});

test('isPlexNotification rejects non-notification bodies', () => {
  assert.equal(isPlexNotification({ event: 'media.play' }), true);
  assert.equal(isPlexNotification({ NotificationContainer: { type: 'playing' } }), true);
  assert.equal(isPlexNotification({}), false);
  assert.equal(isPlexNotification([]), false);
  assert.equal(isPlexNotification('media.play'), false);
});

test('ensureWebhookToken creates a stable file token and honours the env override', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-wh-token-'));
  const file = path.join(dir, 'config', 'webhook.token');
  const first = ensureWebhookToken(file);
  assert.match(first, /^[0-9a-f]{48}$/);
  assert.equal(ensureWebhookToken(file), first);
  assert.equal(ensureWebhookToken(file, '  from-env  '), 'from-env');
});

test('wrong or missing token publishes nothing and fetches no metadata', async () => {
  const ctx = await setup();
  try {
    const body = JSON.stringify(playPayload());
    const headers = { 'Content-Type': 'application/json' };
    for (const url of [
      `${ctx.base}/webhooks/plex`,
      `${ctx.base}/webhooks/plex/${'b'.repeat(48)}`,
      `${ctx.base}/webhooks/plex/short`,
    ]) {
      const res = await fetch(url, { method: 'POST', headers, body });
      assert.equal(res.status, 404, url);
    }
    await settle();
    assert.equal(ctx.received.length, 0);
    assert.equal(ctx.metadataCalls.length, 0);
  } finally {
    await ctx.close();
  }
});

test('valid token with media.play and media.scrobble reaches subscribers', async () => {
  const ctx = await setup();
  try {
    const url = `${ctx.base}/webhooks/plex/${TOKEN}`;
    const play = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(playPayload()),
    });
    assert.equal(play.status, 204);
    const scrobble = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(playPayload({ event: 'media.scrobble' })),
    });
    assert.equal(scrobble.status, 204);
    await settle();
    assert.deepEqual(ctx.metadataCalls, ['55']);
    const names = ctx.received.map((r) => r.name);
    assert.ok(names.includes('playback.started'));
    assert.ok(names.includes('episode.watched'));
    for (const r of ctx.received) {
      assert.equal(r.payload.source, 'webhook');
      assert.equal(r.payload.accountId, OWNER);
    }
  } finally {
    await ctx.close();
  }
});

test('multipart body with a payload field is accepted', async () => {
  const ctx = await setup();
  try {
    const form = new FormData();
    form.append('payload', JSON.stringify(playPayload()));
    form.append('thumb', new Blob([Buffer.alloc(1024)], { type: 'image/jpeg' }), 'thumb.jpg');
    const res = await fetch(`${ctx.base}/webhooks/plex/${TOKEN}`, {
      method: 'POST',
      body: form,
    });
    assert.equal(res.status, 204);
    await settle();
    assert.deepEqual(ctx.metadataCalls, ['55']);
    assert.equal(ctx.received[0].name, 'playback.started');
  } finally {
    await ctx.close();
  }
});

test('oversized and malformed webhook bodies are rejected', async () => {
  const ctx = await setup();
  try {
    const url = `${ctx.base}/webhooks/plex/${TOKEN}`;
    const big = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'media.play', pad: 'x'.repeat(1024 * 1024 + 10) }),
    });
    assert.equal(big.status, 413);
    const notPlex = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    assert.equal(notPlex.status, 400);
    const badField = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'payload=%7Bnot-json',
    });
    assert.equal(badField.status, 400);
    await settle();
    assert.equal(ctx.received.length, 0);
  } finally {
    await ctx.close();
  }
});

test('webhook with no account id or another account does not reach tools', async () => {
  const ctx = await setup();
  try {
    const url = `${ctx.base}/webhooks/plex/${TOKEN}`;
    const bodies = [
      playPayload({ Account: undefined }),
      playPayload({ Account: { id: 999 } }),
      playPayload({ event: 'media.scrobble', Account: undefined }),
      playPayload({ event: 'media.scrobble', Account: { id: 0 } }),
    ];
    for (const body of bodies) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 204);
    }
    await settle();
    assert.equal(ctx.received.length, 0);
    assert.equal(ctx.metadataCalls.length, 0);
  } finally {
    await ctx.close();
  }
});

test('subscriber drops a webhook-sourced event without the configured account', async () => {
  const ctx = await setup();
  try {
    ctx.bus.publish('movie.watched', { source: 'webhook', accountId: '', ratingKey: '1' });
    ctx.bus.publish('movie.watched', { source: 'webhook', accountId: '0', ratingKey: '1' });
    ctx.bus.publish('movie.watched', { source: 'webhook', accountId: OWNER, ratingKey: '1' });
    assert.equal(ctx.received.length, 1);
    assert.equal(ctx.received[0].payload.accountId, OWNER);
  } finally {
    await ctx.close();
  }
});

test('repeated webhook events inside the dedupe window are ignored', async () => {
  const ctx = await setup();
  try {
    assert.equal(ctx.eventMonitor.handleWebhook(playPayload()), true);
    assert.equal(ctx.eventMonitor.handleWebhook(playPayload()), false);
    assert.equal(ctx.eventMonitor.handleWebhook(playPayload({ event: 'media.scrobble' })), true);
    await settle();
    assert.deepEqual(ctx.metadataCalls, ['55']);
  } finally {
    await ctx.close();
  }
});

test('websocket account id 0 is still delivered (owner id not fixture-proven)', async () => {
  const ctx = await setup();
  try {
    ctx.eventMonitor._handleWsMessage({
      NotificationContainer: {
        type: 'playing',
        PlaySessionStateNotification: [
          { state: 'playing', sessionKey: '9', ratingKey: '77', accountID: '0', viewOffset: 0 },
        ],
      },
    });
    await settle();
    assert.deepEqual(ctx.metadataCalls, ['77']);
    assert.equal(ctx.received.length, 1);
    assert.equal(ctx.received[0].payload.source, 'websocket');
    assert.equal(ctx.received[0].payload.accountId, '0');
  } finally {
    await ctx.close();
  }
});
