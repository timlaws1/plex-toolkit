import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createLogger } from '../src/log.js';
import { createSecrets, ensureSecretKey } from '../src/crypto/secrets.js';
import { createApp, adminPasswordMatches } from '../src/http/app.js';

const PASSWORD = 'correct horse battery staple';
const RAW_PLEX_TOKEN = 'RAW-PLEX-TOKEN-0123456789';

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-login-'));
  const db = openDatabase(path.join(dir, 't.sqlite'));
  const logger = createLogger(path.join(dir, 'logs'), db);
  const secrets = createSecrets(ensureSecretKey(path.join(dir, 'secret.key')));
  return { db, logger, secrets };
}

async function startApp({ db, logger, secrets }, { publicUrl = '', loginFailureDelayMs = 0 } = {}) {
  const app = createApp({
    db,
    secrets,
    plex: {
      clientId: 'cid',
      isConfigured: () => true,
      setCredentials() {},
      getServer: async () => ({ name: 'Server A', version: '1.0', machineId: 'server-a' }),
    },
    pluginManager: { listInstalled: () => [], runtime: { getModule: () => null } },
    eventMonitor: { handleWebhook() {}, restart() {} },
    panels: new Map(),
    logger,
    publicUrl,
    webhookToken: 'w'.repeat(48),
    loginFailureDelayMs,
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function sessionCookie(res) {
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('pt_session='));
  return cookie || null;
}

async function login(base, password) {
  return fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString(),
    redirect: 'manual',
  });
}

test.before(() => {
  process.env.ADMIN_PASSWORD = PASSWORD;
});

test('adminPasswordMatches compares exactly and rejects an empty expected password', () => {
  assert.equal(adminPasswordMatches(PASSWORD, PASSWORD), true);
  assert.equal(adminPasswordMatches(`${PASSWORD} `, PASSWORD), false);
  assert.equal(adminPasswordMatches('', ''), false);
  assert.equal(adminPasswordMatches(undefined, PASSWORD), false);
});

test('a wrong password does not create a session; equal-length near misses both fail', async () => {
  const ctx = makeDb();
  const app = await startApp(ctx);
  try {
    const nearMissA = `${PASSWORD.slice(0, -1)}X`;
    const nearMissB = `X${PASSWORD.slice(1)}`;
    assert.equal(nearMissA.length, PASSWORD.length);
    for (const attempt of [nearMissA, nearMissB, '']) {
      const res = await login(app.base, attempt);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/login');
      assert.equal(sessionCookie(res), null);
    }
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);

    const ok = await login(app.base, PASSWORD);
    assert.equal(ok.headers.get('location'), '/');
    assert.ok(sessionCookie(ok));
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n, 0);
  } finally {
    await app.close();
    ctx.db.close();
  }
});

test('a failed login is delayed', async () => {
  const ctx = makeDb();
  const app = await startApp(ctx, { loginFailureDelayMs: 500 });
  try {
    const started = Date.now();
    await login(app.base, 'wrong');
    assert.ok(Date.now() - started >= 450);
  } finally {
    await app.close();
    ctx.db.close();
  }
});

test('repeated failures lock the client out, and the lock survives a restart', async () => {
  const ctx = makeDb();
  let app = await startApp(ctx);
  try {
    for (let i = 0; i < 5; i += 1) {
      await login(app.base, 'wrong');
    }
    const locked = await login(app.base, PASSWORD);
    assert.equal(sessionCookie(locked), null);
    const flash = locked.headers.getSetCookie().find((c) => c.startsWith('pt_flash='));
    assert.match(decodeURIComponent(flash), /Too many failed/);

    await app.close();
    app = await startApp(ctx);
    const afterRestart = await login(app.base, PASSWORD);
    assert.equal(sessionCookie(afterRestart), null);
    const row = ctx.db.prepare('SELECT * FROM login_attempts').get();
    assert.equal(row.failures, 5);
    assert.ok(row.locked_until > Date.now());
  } finally {
    await app.close();
    ctx.db.close();
  }
});

test('a failed login prunes expired attempt rows for other addresses', async () => {
  const ctx = makeDb();
  const app = await startApp(ctx);
  try {
    const now = Date.now();
    const lockMs = 15 * 60 * 1000;
    const insert = ctx.db.prepare(
      'INSERT INTO login_attempts (client, failures, first_failed_at, locked_until) VALUES (?, ?, ?, ?)',
    );
    insert.run('10.0.0.1', 5, now - 2 * lockMs, now - 1000);
    insert.run('10.0.0.2', 2, now - lockMs - 1000, null);
    insert.run('10.0.0.3', 5, now - 1000, now + lockMs);
    insert.run('10.0.0.4', 1, now - 1000, null);

    await login(app.base, 'wrong');

    const clients = ctx.db
      .prepare('SELECT client FROM login_attempts ORDER BY client')
      .all()
      .map((r) => r.client);
    assert.deepEqual(clients.filter((c) => c.startsWith('10.')), ['10.0.0.3', '10.0.0.4']);
    assert.equal(clients.length, 3);
  } finally {
    await app.close();
    ctx.db.close();
  }
});

test('the session cookie is Secure only when PUBLIC_URL is https', async () => {
  const httpsCtx = makeDb();
  const httpsApp = await startApp(httpsCtx, { publicUrl: 'https://toolkit.example' });
  const httpCtx = makeDb();
  const httpApp = await startApp(httpCtx, { publicUrl: 'http://192.168.1.20:8787' });
  try {
    const secure = sessionCookie(await login(httpsApp.base, PASSWORD));
    assert.match(secure, /;\s*Secure/i);
    assert.match(secure, /HttpOnly/i);
    assert.match(secure, /SameSite=Lax/i);
    const plain = sessionCookie(await login(httpApp.base, PASSWORD));
    assert.doesNotMatch(plain, /;\s*Secure/i);
  } finally {
    await httpsApp.close();
    await httpApp.close();
    httpsCtx.db.close();
    httpCtx.db.close();
  }
});

test('upgrading clears plaintext pending Plex tokens left in older sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-login-migrate-'));
  const dbPath = path.join(dir, 't.sqlite');
  let db = openDatabase(dbPath);
  db.prepare('DELETE FROM schema_migrations WHERE id = 10').run();
  const expires = Date.now() + 60_000;
  const insert = db.prepare('INSERT INTO sessions (id, data, expires_at) VALUES (?, ?, ?)');
  insert.run(
    'legacy',
    JSON.stringify({
      authenticated: true,
      pendingPlexToken: RAW_PLEX_TOKEN,
      pendingPlexServers: [{ id: 'server-a' }],
      pendingPlexAccount: { id: 42 },
    }),
    expires,
  );
  insert.run('plain', JSON.stringify({ authenticated: true }), expires);
  insert.run('broken', 'not json', expires);
  db.close();

  db = openDatabase(dbPath);
  try {
    const rows = Object.fromEntries(
      db.prepare('SELECT id, data FROM sessions').all().map((r) => [r.id, r.data]),
    );
    assert.deepEqual(JSON.parse(rows.legacy), { authenticated: true });
    assert.deepEqual(JSON.parse(rows.plain), { authenticated: true });
    assert.equal(rows.broken, 'not json');
    assert.equal(JSON.stringify(rows).includes(RAW_PLEX_TOKEN), false);
  } finally {
    db.close();
  }
});

test('pages refuse framing and sniffing', async () => {
  const ctx = makeDb();
  const app = await startApp(ctx);
  try {
    for (const route of ['/login', '/static/input.css', '/']) {
      const res = await fetch(`${app.base}${route}`, { redirect: 'manual' });
      assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'", route);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', route);
      assert.equal(res.headers.get('x-powered-by'), null, route);
    }
  } finally {
    await app.close();
    ctx.db.close();
  }
});

test('the pending Plex token is encrypted in session JSON and cleared after a server is chosen', async () => {
  const ctx = makeDb();
  const app = await startApp(ctx);
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return original(input, init);
    const json = (body) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    if (url.host === 'plex.tv' && url.pathname === '/api/v2/pins') return json({ id: 7, code: 'ABCD' });
    if (url.host === 'plex.tv' && url.pathname === '/api/v2/pins/7') {
      return json({ authToken: RAW_PLEX_TOKEN });
    }
    if (url.host === 'plex.tv' && url.pathname === '/api/v2/user') return json({ id: 42, username: 'tim' });
    if (url.host === 'plex.tv' && url.pathname === '/api/v2/resources') {
      return json([
        { provides: 'server', clientIdentifier: 'server-a', name: 'Server A', owned: true, connections: [{ uri: 'http://10.0.0.5:32400' }] },
        { provides: 'server', clientIdentifier: 'server-b', name: 'Server B', owned: true, connections: [{ uri: 'http://10.0.0.6:32400' }] },
      ]);
    }
    if (url.pathname === '/identity') return new Response('', { status: 200 });
    return new Response('not stubbed', { status: 500 });
  };
  try {
    const cookie = sessionCookie(await login(app.base, PASSWORD)).split(';')[0];
    const headers = { Cookie: cookie };
    await fetch(`${app.base}/plex/login`, { method: 'POST', headers, redirect: 'manual' });
    const callback = await fetch(`${app.base}/plex/callback`, { headers, redirect: 'manual' });
    assert.equal(callback.headers.get('location'), '/plex');

    const sid = cookie.slice('pt_session='.length);
    const pending = JSON.parse(ctx.db.prepare('SELECT data FROM sessions WHERE id = ?').get(sid).data);
    assert.ok(pending.pendingPlexToken);
    assert.notEqual(pending.pendingPlexToken, RAW_PLEX_TOKEN);
    assert.equal(
      JSON.stringify(ctx.db.prepare('SELECT data FROM sessions').all()).includes(RAW_PLEX_TOKEN),
      false,
    );
    assert.equal(ctx.secrets.decrypt(pending.pendingPlexToken), RAW_PLEX_TOKEN);

    const select = await fetch(`${app.base}/plex/select-server`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'server_id=server-a',
      redirect: 'manual',
    });
    assert.equal(select.headers.get('location'), '/plex');
    const after = JSON.parse(ctx.db.prepare('SELECT data FROM sessions WHERE id = ?').get(sid).data);
    assert.equal(after.pendingPlexToken, null);
    const saved = ctx.db.prepare('SELECT token_encrypted FROM plex_servers').get();
    assert.equal(ctx.secrets.decrypt(saved.token_encrypted), RAW_PLEX_TOKEN);
  } finally {
    globalThis.fetch = original;
    await app.close();
    ctx.db.close();
  }
});
