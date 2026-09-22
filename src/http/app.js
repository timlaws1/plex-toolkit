import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout, escapeHtml, checkbox } from './views/layout.js';
import { getSetting, setSetting } from '../db/index.js';
import {
  createPin,
  waitForPinToken,
  listServers,
  pickReachableUri,
  fetchPlexAccount,
} from '../plex/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export function createApp(ctx) {
  const {
    db,
    secrets,
    plex,
    pluginManager,
    catalogue,
    eventMonitor,
    panels,
    logger,
    publicUrl,
  } = ctx;

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use('/static', express.static(path.join(__dirname, 'public')));

  function getSession(req) {
    const sid = req.cookies?.pt_session;
    if (!sid) return null;
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
      return null;
    }
    try {
      return JSON.parse(row.data);
    } catch {
      return null;
    }
  }

  function setSession(res, data) {
    const id = secrets.randomToken(24);
    const expires = Date.now() + SESSION_TTL_MS;
    db.prepare(
      'INSERT INTO sessions (id, data, expires_at) VALUES (?, ?, ?)',
    ).run(id, JSON.stringify(data), expires);
    res.cookie('pt_session', id, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
    });
    return id;
  }

  function updateSession(req, res, patch) {
    const sid = req.cookies?.pt_session;
    const current = getSession(req) || {};
    const next = { ...current, ...patch };
    if (!sid) {
      setSession(res, next);
      return next;
    }
    const expires = Date.now() + SESSION_TTL_MS;
    db.prepare(
      `UPDATE sessions SET data = ?, expires_at = ? WHERE id = ?`,
    ).run(JSON.stringify(next), expires, sid);
    res.cookie('pt_session', sid, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
    });
    return next;
  }

  function clearSession(req, res) {
    const sid = req.cookies?.pt_session;
    if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    res.clearCookie('pt_session');
  }

  function flash(res, type, message) {
    res.cookie('pt_flash', JSON.stringify({ type, message }), {
      httpOnly: true,
      maxAge: 60_000,
    });
  }

  function takeFlash(req, res) {
    const raw = req.cookies?.pt_flash;
    if (!raw) return null;
    res.clearCookie('pt_flash');
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function requireAuth(req, res, next) {
    const session = getSession(req);
    if (!session?.authenticated) {
      return res.redirect('/login');
    }
    req.user = session;
    next();
  }

  function render(req, res, { title, nav, body }) {
    res.send(
      layout({
        title,
        nav,
        body,
        flash: takeFlash(req, res),
        user: req.user,
      }),
    );
  }

  function getPlexServerRow() {
    return db.prepare('SELECT * FROM plex_servers ORDER BY id ASC LIMIT 1').get();
  }

  function configuredAccountId() {
    return getPlexServerRow()?.plex_account_id || null;
  }

  // --- Webhook (no auth; Plex servers call this) ---
  app.post('/webhooks/plex', (req, res) => {
    try {
      let payload = req.body;
      // Multipart form from Plex sometimes sends payload as JSON string field
      if (payload?.payload && typeof payload.payload === 'string') {
        payload = JSON.parse(payload.payload);
      }
      eventMonitor.handleWebhook(payload);
      res.status(204).end();
    } catch (err) {
      logger.warn(`Webhook error: ${err.message}`);
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/login', (req, res) => {
    if (getSession(req)?.authenticated) return res.redirect('/');
    req.user = null;
    render(req, res, {
      title: 'Login',
      nav: null,
      body: `<div class="login-wrap card">
        <h1>Sign in</h1>
        <p class="muted">Enter the admin password configured for this container.</p>
        <form method="post" action="/login">
          <label>Password</label>
          <input type="password" name="password" required autofocus />
          <div class="row-actions"><button class="primary" type="submit">Sign in</button></div>
        </form>
      </div>`,
    });
  });

  app.post('/login', (req, res) => {
    const password = req.body.password || '';
    const expected = process.env.ADMIN_PASSWORD || '';
    if (!expected || password !== expected) {
      flash(res, 'error', 'Invalid password');
      return res.redirect('/login');
    }
    setSession(res, { authenticated: true, at: Date.now() });
    res.redirect('/');
  });

  app.post('/logout', (req, res) => {
    clearSession(req, res);
    res.redirect('/login');
  });

  app.get('/', requireAuth, (req, res) => {
    const server = getPlexServerRow();
    const plugins = pluginManager.listInstalled();
    const activity = db
      .prepare(
        `SELECT * FROM plugin_activity ORDER BY created_at DESC LIMIT 20`,
      )
      .all();

    const statusBadge = server?.last_ok_at
      ? `<span class="badge ok">Connected</span>`
      : server
        ? `<span class="badge warn">Configured</span>`
        : `<span class="badge err">Not connected</span>`;

    const pluginRows = plugins
      .map(
        (p) => `<tr>
        <td>${escapeHtml(p.name)}</td>
        <td class="mono">${escapeHtml(p.version)}</td>
        <td>${p.enabled ? (p.active ? '<span class="badge ok">Active</span>' : '<span class="badge warn">Enabled</span>') : '<span class="badge">Disabled</span>'}</td>
      </tr>`,
      )
      .join('') || `<tr><td colspan="3" class="muted">No plugins installed</td></tr>`;

    const activityRows = activity
      .map(
        (a) => `<tr>
        <td class="mono">${escapeHtml(a.created_at)}</td>
        <td>${escapeHtml(a.plugin_id || '—')}</td>
        <td>${escapeHtml(a.level)}</td>
        <td>${escapeHtml(a.message)}</td>
      </tr>`,
      )
      .join('') || `<tr><td colspan="4" class="muted">No recent activity</td></tr>`;

    render(req, res, {
      title: 'Dashboard',
      nav: 'dashboard',
      body: `
        <h1>Dashboard</h1>
        <div class="grid">
          <div class="card">
            <h3>Plex</h3>
            <div>${statusBadge}</div>
            <p class="stat">${escapeHtml(server?.name || '—')}</p>
            <p class="muted">Version ${escapeHtml(server?.version || 'unknown')}</p>
            ${server?.last_error ? `<p class="muted">Last error: ${escapeHtml(server.last_error)}</p>` : ''}
          </div>
          <div class="card">
            <h3>Plugins</h3>
            <p class="stat">${plugins.length}</p>
            <p class="muted">${plugins.filter((p) => p.enabled).length} enabled</p>
          </div>
          <div class="card">
            <h3>Webhook</h3>
            <p class="muted mono">${escapeHtml((publicUrl || '(set PUBLIC_URL)') + '/webhooks/plex')}</p>
          </div>
        </div>
        <h2>Installed plugins</h2>
        <div class="card"><table class="table"><thead><tr><th>Name</th><th>Version</th><th>Status</th></tr></thead><tbody>${pluginRows}</tbody></table></div>
        <h2>Recent activity</h2>
        <div class="card"><table class="table"><thead><tr><th>When</th><th>Plugin</th><th>Level</th><th>Message</th></tr></thead><tbody>${activityRows}</tbody></table></div>
      `,
    });
  });

  app.get('/plex', requireAuth, async (req, res) => {
    const server = getPlexServerRow();
    const pendingServers = req.user?.pendingPlexServers || null;
    let body;

    if (pendingServers?.length) {
      const options = pendingServers
        .map(
          (s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}${
            s.owned ? '' : ' (shared)'
          }</option>`,
        )
        .join('');
      body = `
        <h1>Choose a Plex server</h1>
        <p class="muted">Your Plex account is signed in. Select which Media Server this toolkit should use.</p>
        <div class="card">
          <form method="post" action="/plex/select-server">
            <label>Server</label>
            <select name="server_id" required>${options}</select>
            <div class="row-actions">
              <button class="primary" type="submit">Connect server</button>
              <a class="btn" href="/plex/login">Cancel</a>
            </div>
          </form>
        </div>`;
    } else if (!server?.token_encrypted) {
      body = `
        <h1>Plex connection</h1>
        <div class="card">
          <p>Sign in with your Plex account. Plex Toolkit will discover your Media Server automatically — you do not need to paste a token or URL.</p>
          <form method="post" action="/plex/login">
            <div class="row-actions">
              <button class="primary" type="submit">Log in with Plex</button>
            </div>
          </form>
        </div>`;
    } else {
      const connected = Boolean(server.last_ok_at && server.url);
      body = `
        <h1>Plex connection</h1>
        <div class="card">
          <p>
            ${
              connected
                ? '<span class="badge ok">Connected</span>'
                : '<span class="badge warn">Signed in</span>'
            }
            ${
              server.account_username
                ? ` as <strong>${escapeHtml(server.account_username)}</strong>`
                : ''
            }
          </p>
          <p class="stat">${escapeHtml(server.name || 'Plex')}</p>
          <p class="muted">Server URL: <span class="mono">${escapeHtml(server.url || 'not set')}</span></p>
          <p class="muted">Version: ${escapeHtml(server.version || '—')}</p>
          <p class="muted">Machine ID: <span class="mono">${escapeHtml(server.machine_id || '—')}</span></p>
          <p class="muted">Account ID: <span class="mono">${escapeHtml(server.plex_account_id || '—')}</span></p>
          <p class="muted">Last OK: ${escapeHtml(server.last_ok_at || '—')}</p>
          ${server.last_error ? `<p class="muted">Last error: ${escapeHtml(server.last_error)}</p>` : ''}
          <div class="row-actions">
            <form method="post" action="/plex/test"><button type="submit">Test connection</button></form>
            <form method="post" action="/plex/login"><button type="submit">Re-login with Plex</button></form>
            <form method="post" action="/plex/disconnect" onsubmit="return confirm('Disconnect Plex from this toolkit?')">
              <button class="danger" type="submit">Disconnect</button>
            </form>
          </div>
        </div>
        <h2>Server URL override</h2>
        <div class="card">
          <p class="muted">Only needed if automatic discovery cannot reach your server (e.g. custom LAN address).</p>
          <form method="post" action="/plex/server-url">
            <label>Server URL</label>
            <input type="url" name="url" placeholder="http://192.168.1.10:32400" value="${escapeHtml(server.url || '')}" />
            <div class="row-actions"><button type="submit">Save URL</button></div>
          </form>
        </div>`;
    }

    render(req, res, { title: 'Plex', nav: 'plex', body });
  });

  app.post('/plex/login', requireAuth, async (req, res) => {
    try {
      const pin = await createPin(plex.clientId);
      updateSession(req, res, {
        plex_pin: {
          id: pin.id,
          code: pin.code,
          authUrl: pin.authUrl,
        },
        pendingPlexServers: null,
        pendingPlexToken: null,
      });
      res.redirect('/plex/claim');
    } catch (err) {
      flash(res, 'error', err.message);
      res.redirect('/plex');
    }
  });

  app.get('/plex/claim', requireAuth, (req, res) => {
    const pin = req.user?.plex_pin;
    if (!pin?.authUrl) {
      flash(res, 'error', 'Plex authorization expired. Please try again.');
      return res.redirect('/plex');
    }
    render(req, res, {
      title: 'Authorize Plex',
      nav: 'plex',
      body: `
        <h1>Authorize Plex</h1>
        <div class="card">
          <p>Open Plex to approve <strong>Plex Toolkit</strong>, then return here and continue.</p>
          <div class="row-actions">
            <a class="btn primary" href="${escapeHtml(pin.authUrl)}" target="_blank" rel="noopener noreferrer">Open Plex authorization</a>
            <a class="btn" href="/plex/callback">I've authorized — continue</a>
          </div>
          <p class="muted" style="margin-top:1rem"><a href="/plex">Cancel</a></p>
        </div>`,
    });
  });

  app.get('/plex/callback', requireAuth, async (req, res) => {
    const pin = req.user?.plex_pin;
    if (!pin?.id) {
      flash(res, 'error', 'Plex authorization expired. Please try again.');
      return res.redirect('/plex');
    }

    try {
      const token = await waitForPinToken(plex.clientId, pin.id);
      if (!token) {
        flash(
          res,
          'error',
          'Plex authorization was not completed. Approve the app in Plex, then try again.',
        );
        return res.redirect('/plex/claim');
      }

      let account = null;
      try {
        account = await fetchPlexAccount(plex.clientId, token);
      } catch (err) {
        logger.warn(`Plex account lookup failed: ${err.message}`);
      }

      const servers = await listServers(plex.clientId, token);
      updateSession(req, res, {
        plex_pin: null,
        pendingPlexToken: token,
        pendingPlexAccount: account,
        pendingPlexServers: servers,
      });

      if (servers.length === 0) {
        await persistPlexConnection({
          token,
          url: '',
          account,
          serverMeta: { name: 'Plex Account', machineId: null },
        });
        updateSession(req, res, {
          pendingPlexToken: null,
          pendingPlexServers: null,
          pendingPlexAccount: null,
        });
        flash(
          res,
          'warn',
          'Plex account connected, but no Media Server was found. You can set a server URL manually.',
        );
        return res.redirect('/plex');
      }

      if (servers.length === 1) {
        const result = await connectChosenServer(token, servers[0], account);
        updateSession(req, res, {
          pendingPlexToken: null,
          pendingPlexServers: null,
          pendingPlexAccount: null,
        });
        flash(res, result.type, result.message);
        return res.redirect('/plex');
      }

      flash(res, 'ok', 'Plex account authorized. Choose a server to continue.');
      res.redirect('/plex');
    } catch (err) {
      flash(res, 'error', err.message);
      res.redirect('/plex');
    }
  });

  app.post('/plex/select-server', requireAuth, async (req, res) => {
    const token = req.user?.pendingPlexToken;
    const servers = req.user?.pendingPlexServers || [];
    const account = req.user?.pendingPlexAccount || null;
    const serverId = String(req.body.server_id || '');
    const server = servers.find((s) => s.id === serverId);
    if (!token || !server) {
      flash(res, 'error', 'Server selection expired. Please log in with Plex again.');
      return res.redirect('/plex');
    }
    try {
      const result = await connectChosenServer(token, server, account);
      updateSession(req, res, {
        pendingPlexToken: null,
        pendingPlexServers: null,
        pendingPlexAccount: null,
      });
      flash(res, result.type, result.message);
    } catch (err) {
      flash(res, 'error', err.message);
    }
    res.redirect('/plex');
  });

  async function connectChosenServer(token, server, account) {
    const reachable =
      (await pickReachableUri(plex.clientId, token, server.uris || [])) ||
      server.uri ||
      '';
    await persistPlexConnection({
      token,
      url: reachable,
      account,
      serverMeta: {
        name: server.name,
        machineId: server.id,
      },
      connectionUris: server.uris || [],
    });

    let result;
    if (!reachable) {
      result = {
        type: 'warn',
        message: `Signed in to ${server.name}, but no reachable URL responded. Set your server URL manually if needed.`,
      };
    } else {
      try {
        const info = await plex.getServer();
        const row = getPlexServerRow();
        db.prepare(
          `UPDATE plex_servers SET name = ?, version = ?, machine_id = COALESCE(?, machine_id),
           last_ok_at = datetime('now'), last_error = NULL, updated_at = datetime('now') WHERE id = ?`,
        ).run(info.name, info.version, info.machineId, row.id);
        result = {
          type: 'ok',
          message: `Connected to ${info.name}${account?.username ? ` as ${account.username}` : ''}`,
        };
      } catch (err) {
        result = {
          type: 'warn',
          message: `Saved ${server.name} at ${reachable}, but a live check failed: ${err.message}`,
        };
      }
    }
    eventMonitor.restart();
    return result;
  }

  async function persistPlexConnection({
    token,
    url,
    account,
    serverMeta,
    connectionUris = [],
  }) {
    const encrypted = secrets.encrypt(token);
    const existing = getPlexServerRow();
    const username = account?.username || null;
    const accountId = account?.id || null;
    if (existing) {
      db.prepare(
        `UPDATE plex_servers SET
           url = ?, token_encrypted = ?, name = ?, machine_id = ?,
           plex_account_id = COALESCE(?, plex_account_id),
           account_username = COALESCE(?, account_username),
           connection_uris = ?, connected_at = COALESCE(connected_at, datetime('now')),
           last_error = NULL, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        url || '',
        encrypted,
        serverMeta?.name || existing.name,
        serverMeta?.machineId || existing.machine_id,
        accountId,
        username,
        JSON.stringify(connectionUris),
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO plex_servers
         (url, token_encrypted, name, machine_id, plex_account_id, account_username, connection_uris, connected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(
        url || '',
        encrypted,
        serverMeta?.name || null,
        serverMeta?.machineId || null,
        accountId,
        username,
        JSON.stringify(connectionUris),
      );
    }
    plex.setCredentials({ url: url || '', token });
  }

  app.post('/plex/server-url', requireAuth, async (req, res) => {
    const row = getPlexServerRow();
    if (!row?.token_encrypted) {
      flash(res, 'error', 'Log in with Plex first');
      return res.redirect('/plex');
    }
    const url = String(req.body.url || '').trim().replace(/\/$/, '');
    db.prepare(
      `UPDATE plex_servers SET url = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(url, row.id);
    plex.setCredentials({
      url,
      token: secrets.decrypt(row.token_encrypted),
    });
    flash(res, 'ok', 'Server URL saved');
    res.redirect('/plex');
  });

  app.post('/plex/test', requireAuth, async (req, res) => {
    const row = getPlexServerRow();
    if (!row?.token_encrypted) {
      flash(res, 'error', 'Log in with Plex first');
      return res.redirect('/plex');
    }
    try {
      const token = secrets.decrypt(row.token_encrypted);
      plex.setCredentials({ url: row.url, token });
      if (!row.url) throw new Error('Server URL is not set');
      const info = await plex.getServer();
      let accountId = row.plex_account_id;
      let accountLabel = row.account_username;
      try {
        const account = await plex.getTokenAccount();
        accountId = account.id || accountId;
        accountLabel = account.username || accountLabel;
      } catch (err) {
        logger.warn(`Could not resolve plex.tv account id: ${err.message}`);
      }
      db.prepare(
        `UPDATE plex_servers SET name = ?, version = ?, machine_id = ?,
         plex_account_id = COALESCE(?, plex_account_id),
         account_username = COALESCE(?, account_username),
         last_ok_at = datetime('now'), last_error = NULL,
         connected_at = COALESCE(connected_at, datetime('now')),
         updated_at = datetime('now') WHERE id = ?`,
      ).run(
        info.name,
        info.version,
        info.machineId,
        accountId,
        accountLabel,
        row.id,
      );
      eventMonitor.restart();
      flash(
        res,
        'ok',
        `Connected to ${info.name} (${info.version || 'unknown version'})${
          accountLabel ? ` as ${accountLabel}` : ''
        }`,
      );
    } catch (err) {
      db.prepare(
        `UPDATE plex_servers SET last_error = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(err.message, row.id);
      flash(res, 'error', err.message);
    }
    res.redirect('/plex');
  });

  app.post('/plex/disconnect', requireAuth, (req, res) => {
    const row = getPlexServerRow();
    if (row) {
      db.prepare('DELETE FROM plex_servers WHERE id = ?').run(row.id);
    }
    plex.setCredentials({ url: '', token: '' });
    updateSession(req, res, {
      plex_pin: null,
      pendingPlexToken: null,
      pendingPlexServers: null,
      pendingPlexAccount: null,
    });
    eventMonitor.stop();
    flash(res, 'ok', 'Plex disconnected');
    res.redirect('/plex');
  });

  // Legacy no-op redirects from old manual form endpoints
  app.post('/plex', requireAuth, (_req, res) => res.redirect('/plex'));
  app.get('/plugins', requireAuth, (req, res) => {
    const plugins = pluginManager.listInstalled();
    const rows =
      plugins
        .map((p) => {
          const status = p.enabled
            ? p.active
              ? '<span class="badge ok">Enabled</span>'
              : '<span class="badge warn">Enabled (inactive)</span>'
            : '<span class="badge">Disabled</span>';
          return `<div class="plugin-row">
            <div>
              <strong>${escapeHtml(p.name)}</strong>
              <div class="muted">Version ${escapeHtml(p.version)} · ${escapeHtml(p.id)}</div>
              <div style="margin-top:0.35rem">${status}</div>
              ${p.last_error ? `<div class="muted">Error: ${escapeHtml(p.last_error)}</div>` : ''}
              <p class="muted">${escapeHtml(p.description || '')}</p>
            </div>
            <div class="row-actions">
              <a class="btn" href="/plugins/${encodeURIComponent(p.id)}">Settings</a>
              <form method="post" action="/plugins/${encodeURIComponent(p.id)}/${p.enabled ? 'disable' : 'enable'}">
                <button type="submit">${p.enabled ? 'Disable' : 'Enable'}</button>
              </form>
              <form method="post" action="/plugins/${encodeURIComponent(p.id)}/update">
                <button type="submit">Update</button>
              </form>
              <form method="post" action="/plugins/${encodeURIComponent(p.id)}/remove" onsubmit="return confirm('Remove this plugin?')">
                <button class="danger" type="submit">Remove</button>
              </form>
            </div>
          </div>`;
        })
        .join('') || '<p class="muted">No plugins installed yet. Visit the Repository page.</p>';

    render(req, res, {
      title: 'Plugins',
      nav: 'plugins',
      body: `<h1>Installed plugins</h1><div class="card">${rows}</div>`,
    });
  });

  app.get('/plugins/:id', requireAuth, async (req, res) => {
    const plugin = pluginManager.get(req.params.id);
    if (!plugin) {
      flash(res, 'error', 'Plugin not found');
      return res.redirect('/plugins');
    }
    const manifest = pluginManager.getManifest(plugin.id) || {};
    const settings = pluginManager.getSettings(plugin.id, { forDisplay: true });
    const schema = manifest.settingsSchema || [];
    let libraries = [];
    let shows = [];
    try {
      if (plex.isConfigured()) {
        libraries = (await plex.getLibraries()).filter(
          (l) => l.type === 'show' || l.type === 'movie',
        );
        const selectedLibs = settings.libraries || [];
        for (const libId of selectedLibs) {
          try {
            const libShows = await plex.getShows(libId);
            shows.push(...libShows);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }

    const fields = schema
      .map((field) => renderSettingField(field, settings, libraries, shows))
      .join('');

    const panel = panels.get(plugin.id);
    let panelHtml = '';
    if (panel) {
      panelHtml = renderPanel(plugin.id, panel);
    }

    const mod = pluginManager.runtime.getModule(plugin.id);
    const hasApp =
      typeof mod?.handleRequest === 'function' ||
      typeof mod?.default?.handleRequest === 'function';
    const appLink = hasApp
      ? `<p style="margin:0.75rem 0"><a class="btn primary" href="/plugins/${encodeURIComponent(plugin.id)}/app">Open plugin</a></p>`
      : '';

    let customSettingsHtml = '';
    const settingsHtmlPath = path.join(
      pluginManager.pluginPath(plugin.id),
      'settings.html',
    );
    if (fs.existsSync(settingsHtmlPath)) {
      customSettingsHtml = `<h2>Plugin UI</h2>
        <div class="card" style="padding:0;overflow:hidden">
          <iframe
            title="Plugin settings"
            src="/plugins/${encodeURIComponent(plugin.id)}/settings-frame"
            sandbox=""
            style="width:100%;min-height:240px;border:0;background:#111"
          ></iframe>
        </div>`;
    }

    render(req, res, {
      title: plugin.name,
      nav: 'plugins',
      body: `
        <h1>${escapeHtml(plugin.name)}</h1>
        <p class="muted">Version ${escapeHtml(plugin.version)}</p>
        ${appLink}
        <div class="card">
          <form method="post" action="/plugins/${encodeURIComponent(plugin.id)}/settings">
            ${fields || '<p class="muted">No settings defined.</p>'}
            <div class="row-actions"><button class="primary" type="submit">Save settings</button></div>
          </form>
        </div>
        ${panelHtml}
        ${customSettingsHtml}
        <p style="margin-top:1rem"><a href="/plugins">← Back to plugins</a></p>
      `,
    });
  });

  app.get('/plugins/:id/settings-frame', requireAuth, (req, res) => {
    const plugin = pluginManager.get(req.params.id);
    if (!plugin) return res.status(404).end();
    const settingsHtmlPath = path.join(
      pluginManager.pluginPath(plugin.id),
      'settings.html',
    );
    if (!fs.existsSync(settingsHtmlPath)) return res.status(404).end();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.send(fs.readFileSync(settingsHtmlPath, 'utf8'));
  });

  app.post('/plugins/:id/settings', requireAuth, async (req, res) => {
    const plugin = pluginManager.get(req.params.id);
    if (!plugin) {
      flash(res, 'error', 'Plugin not found');
      return res.redirect('/plugins');
    }
    const manifest = pluginManager.getManifest(plugin.id) || {};
    const schema = manifest.settingsSchema || [];
    const settings = {};
    for (const field of schema) {
      settings[field.key] = parseFieldValue(field, req.body);
    }
    pluginManager.saveSettings(plugin.id, settings);
    // Reload plugin so settings take effect
    if (plugin.enabled) {
      try {
        await pluginManager.disable(plugin.id);
        await pluginManager.enable(plugin.id);
      } catch (err) {
        flash(res, 'warn', `Settings saved but reload failed: ${err.message}`);
        return res.redirect(`/plugins/${encodeURIComponent(plugin.id)}`);
      }
    }
    flash(res, 'ok', 'Settings saved');
    res.redirect(`/plugins/${encodeURIComponent(plugin.id)}`);
  });

  app.post('/plugins/:id/enable', requireAuth, async (req, res) => {
    try {
      await pluginManager.enable(req.params.id);
      flash(res, 'ok', 'Plugin enabled');
    } catch (err) {
      flash(res, 'error', err.message);
    }
    res.redirect('/plugins');
  });

  app.post('/plugins/:id/disable', requireAuth, async (req, res) => {
    try {
      await pluginManager.disable(req.params.id);
      flash(res, 'ok', 'Plugin disabled');
    } catch (err) {
      flash(res, 'error', err.message);
    }
    res.redirect('/plugins');
  });

  app.post('/plugins/:id/update', requireAuth, async (req, res) => {
    try {
      await pluginManager.update(req.params.id);
      flash(res, 'ok', 'Plugin updated');
    } catch (err) {
      flash(res, 'error', err.message);
    }
    res.redirect('/plugins');
  });

  app.post('/plugins/:id/remove', requireAuth, async (req, res) => {
    try {
      await pluginManager.remove(req.params.id);
      flash(res, 'ok', 'Plugin removed');
    } catch (err) {
      flash(res, 'error', err.message);
    }
    res.redirect('/plugins');
  });

  app.post('/plugins/:id/panel/:action', requireAuth, async (req, res) => {
    const api = pluginManager.runtime.getApi(req.params.id);
    if (!api) {
      flash(res, 'error', 'Plugin is not active');
      return res.redirect(`/plugins/${encodeURIComponent(req.params.id)}`);
    }
    const panel = panels.get(req.params.id);
    const action = panel?.actions?.[req.params.action];
    if (!action) {
      flash(res, 'error', 'Unknown action');
      return res.redirect(`/plugins/${encodeURIComponent(req.params.id)}`);
    }
    try {
      const result = await action({
        body: req.body,
        force: req.body.force === '1',
      });
      if (result?.warning) {
        flash(res, 'warn', result.warning);
      } else if (result?.message) {
        flash(res, 'ok', result.message);
      } else {
        flash(res, 'ok', 'Done');
      }
    } catch (err) {
      flash(res, 'error', err.message);
    }
    res.redirect(`/plugins/${encodeURIComponent(req.params.id)}`);
  });

  async function handlePluginApp(req, res) {
    const plugin = pluginManager.get(req.params.id);
    if (!plugin) {
      flash(res, 'error', 'Plugin not found');
      return res.redirect('/plugins');
    }
    if (!plugin.enabled || !pluginManager.runtime.isActive(plugin.id)) {
      flash(res, 'error', 'Plugin is not active. Enable it first.');
      return res.redirect(`/plugins/${encodeURIComponent(plugin.id)}`);
    }

    const mod = pluginManager.runtime.getModule(plugin.id);
    const handleRequest =
      typeof mod?.handleRequest === 'function'
        ? mod.handleRequest
        : typeof mod?.default?.handleRequest === 'function'
          ? mod.default.handleRequest
          : null;
    if (!handleRequest) {
      flash(res, 'error', 'This plugin has no app page');
      return res.redirect(`/plugins/${encodeURIComponent(plugin.id)}`);
    }

    const api = pluginManager.runtime.getApi(plugin.id);
    try {
      const result = await handleRequest(api, {
        method: req.method,
        path: req.path,
        query: req.query || {},
        body: req.body || {},
        params: req.params,
      });

      if (result?.redirect) {
        if (result.message) {
          flash(res, result.flash || 'ok', result.message);
        }
        return res.redirect(result.redirect);
      }

      const title = result?.title || plugin.name;
      const body = result?.body || result?.html || '';
      render(req, res, {
        title,
        nav: 'plugins',
        body: `${body}
          <p style="margin-top:1rem"><a href="/plugins/${encodeURIComponent(plugin.id)}">← Plugin settings</a></p>`,
      });
    } catch (err) {
      logger.error(`Plugin app error (${plugin.id}): ${err.message}`, {
        pluginId: plugin.id,
      });
      flash(res, 'error', err.message);
      res.redirect(`/plugins/${encodeURIComponent(plugin.id)}`);
    }
  }

  app.get('/plugins/:id/app', requireAuth, handlePluginApp);
  app.post('/plugins/:id/app', requireAuth, handlePluginApp);

  app.get('/repository', requireAuth, async (req, res) => {
    const catalogueUrl = catalogue.getUrl();
    const cat = await catalogue.fetch();
    const installed = new Set(pluginManager.listInstalled().map((p) => p.id));
    const cards = (cat.plugins || [])
      .map((p) => {
        const installedBadge = installed.has(p.id)
          ? '<span class="badge ok">Installed</span>'
          : '';
        return `<div class="card" style="margin-bottom:1rem">
          <h3>${escapeHtml(p.name)} ${installedBadge}</h3>
          <p class="muted">${escapeHtml(p.description || '')}</p>
          <p class="mono muted">${escapeHtml(p.repository || '')}</p>
          ${
            p.repository
              ? `<form method="post" action="/repository/install" onsubmit="return confirm('Install third-party plugin code from GitHub? This runs inside Plex Toolkit.')">
                  <input type="hidden" name="repository" value="${escapeHtml(p.repository)}" />
                  <input type="hidden" name="confirm" value="1" />
                  <button class="primary" type="submit" ${installed.has(p.id) ? 'disabled' : ''}>Install</button>
                </form>`
              : '<p class="muted">No repository URL configured for this catalogue entry.</p>'
          }
        </div>`;
      })
      .join('') || '<p class="muted">No plugins in catalogue.</p>';

    render(req, res, {
      title: 'Repository',
      nav: 'repository',
      body: `
        <h1>Plugin repository</h1>
        <div class="warn-box">
          Plugins are executable code. Only install plugins you trust.
          Installing from GitHub downloads and runs third-party JavaScript inside this container.
        </div>
        <div class="card">
          <form method="post" action="/repository/catalogue">
            <label>Catalogue URL (repository.json)</label>
            <input type="url" name="catalogue_url" value="${escapeHtml(catalogueUrl)}" placeholder="https://raw.githubusercontent.com/.../repository.json" />
            <div class="row-actions"><button type="submit">Save catalogue URL</button></div>
          </form>
          ${cat.error ? `<p class="muted">${escapeHtml(cat.error)}</p>` : `<p class="muted">${escapeHtml(cat.name || 'Catalogue')}</p>`}
        </div>
        <h2>Available plugins</h2>
        ${cards}
        <h2>Install from GitHub</h2>
        <div class="card">
          <form method="post" action="/repository/install" onsubmit="return confirm('Install third-party plugin code from GitHub?')">
            <label>GitHub repository URL or owner/repo</label>
            <input type="text" name="repository" placeholder="https://github.com/example/plex-toolkit-netflix-rewatch" required />
            <label>Branch / ref</label>
            <input type="text" name="ref" value="main" />
            <input type="hidden" name="confirm" value="1" />
            <div class="row-actions"><button class="primary" type="submit">Install</button></div>
          </form>
        </div>
        <h2>Install from local path (dev)</h2>
        <div class="card">
          <form method="post" action="/repository/install-local">
            <label>Absolute or relative path under PLUGIN_LOCAL_ROOTS</label>
            <input type="text" name="path" placeholder="../plex-toolkit-netflix-rewatch" required />
            <div class="row-actions"><button type="submit">Install local</button></div>
          </form>
        </div>
      `,
    });
  });

  app.post('/repository/catalogue', requireAuth, (req, res) => {
    catalogue.setUrl(String(req.body.catalogue_url || '').trim());
    flash(res, 'ok', 'Catalogue URL saved');
    res.redirect('/repository');
  });

  app.post('/repository/install', requireAuth, async (req, res) => {
    if (req.body.confirm !== '1') {
      flash(res, 'error', 'Installation not confirmed');
      return res.redirect('/repository');
    }
    try {
      const plugin = await pluginManager.installFromGithub(
        String(req.body.repository || ''),
        { ref: String(req.body.ref || 'main'), enable: false },
      );
      flash(
        res,
        'ok',
        `Installed ${plugin.name}. Enable it from the Plugins page after reviewing settings.`,
      );
      res.redirect(`/plugins/${encodeURIComponent(plugin.id)}`);
    } catch (err) {
      flash(res, 'error', err.message);
      res.redirect('/repository');
    }
  });

  app.post('/repository/install-local', requireAuth, async (req, res) => {
    try {
      const plugin = await pluginManager.installFromLocal(
        String(req.body.path || ''),
        { enable: false },
      );
      flash(res, 'ok', `Installed ${plugin.name} from local path`);
      res.redirect(`/plugins/${encodeURIComponent(plugin.id)}`);
    } catch (err) {
      flash(res, 'error', err.message);
      res.redirect('/repository');
    }
  });

  // Expose helpers for tests / index
  app.locals.ctx = ctx;
  void configuredAccountId;
  void getSetting;
  void setSetting;

  return app;
}

function parseFieldValue(field, body) {
  const key = field.key;
  if (field.type === 'boolean') {
    return body[key] === '1' || body[key] === 'on' || body[key] === true;
  }
  if (field.type === 'number') {
    const n = Number(body[key]);
    return Number.isFinite(n) ? n : field.default ?? 0;
  }
  if (field.type === 'plexLibraries' || field.type === 'multiSelect') {
    const raw = body[key];
    if (Array.isArray(raw)) return raw.map(String);
    if (raw == null || raw === '') return [];
    return [String(raw)];
  }
  if (field.type === 'stringList' || field.type === 'plexShows') {
    const text = String(body[key] || '');
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (field.type === 'secret') {
    return body[key] != null ? String(body[key]) : '';
  }
  return body[key] != null ? String(body[key]) : field.default ?? '';
}

function renderSettingField(field, settings, libraries, shows) {
  const value =
    settings[field.key] !== undefined ? settings[field.key] : field.default;
  const label = `<label>${escapeHtml(field.label || field.key)}</label>`;
  const help = field.help
    ? `<p class="muted">${escapeHtml(field.help)}</p>`
    : '';

  if (field.type === 'boolean') {
    return `<div>${label}<div class="checks"><label>${checkbox(field.key, Boolean(value))} Yes</label></div>${help}</div>`;
  }
  if (field.type === 'number') {
    return `<div>${label}<input type="number" name="${escapeHtml(field.key)}" value="${escapeHtml(value ?? '')}" ${field.min != null ? `min="${field.min}"` : ''} ${field.max != null ? `max="${field.max}"` : ''} />${help}</div>`;
  }
  if (field.type === 'secret') {
    const isSet = Boolean(settings[`${field.key}__set`]);
    const placeholder = isSet ? '•••••••• (leave blank to keep)' : '';
    return `<div>${label}<input type="password" name="${escapeHtml(field.key)}" value="" autocomplete="new-password" placeholder="${escapeHtml(placeholder)}" />${help}</div>`;
  }
  if (field.type === 'plexLibraries') {
    const selected = new Set((value || []).map(String));
    const checks = libraries
      .map(
        (lib) =>
          `<label><input type="checkbox" name="${escapeHtml(field.key)}" value="${escapeHtml(lib.id)}" ${selected.has(String(lib.id)) ? 'checked' : ''} /> ${escapeHtml(lib.title)}${lib.type ? ` <span class="muted">(${escapeHtml(lib.type)})</span>` : ''}</label>`,
      )
      .join('') || '<p class="muted">Connect Plex and ensure libraries exist.</p>';
    return `<div>${label}<div class="checks">${checks}</div>${help}</div>`;
  }
  if (field.type === 'stringList' || field.type === 'plexShows') {
    const text = Array.isArray(value) ? value.join('\n') : '';
    const placeholder =
      field.type === 'plexShows'
        ? 'One show title per line'
        : field.placeholder || '';
    return `<div>${label}<textarea name="${escapeHtml(field.key)}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(text)}</textarea>${help}</div>`;
  }
  return `<div>${label}<input type="text" name="${escapeHtml(field.key)}" value="${escapeHtml(value ?? '')}" />${help}</div>`;
}

function renderPanel(pluginId, panel) {
  const items = (panel.items || [])
    .map((item) => {
      const actions = (item.actions || [])
        .map((a) => {
          const onsubmit = a.confirm
            ? ` onsubmit="return confirm('${escapeHtml(a.confirm)}')"`
            : '';
          return `<form method="post" action="/plugins/${encodeURIComponent(pluginId)}/panel/${encodeURIComponent(a.id)}" style="display:inline"${onsubmit}>
            <input type="hidden" name="itemId" value="${escapeHtml(item.id)}" />
            <button type="submit">${escapeHtml(a.label)}</button>
          </form>`;
        })
        .join(' ');
      return `<tr>
        <td>${escapeHtml(item.title)}</td>
        <td class="muted">${escapeHtml(item.subtitle || '')}</td>
        <td>${escapeHtml(item.meta || '')}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join('') || `<tr><td colspan="4" class="muted">${escapeHtml(panel.empty || 'Nothing yet')}</td></tr>`;

  return `<h2>${escapeHtml(panel.title || 'Plugin panel')}</h2>
    <div class="card">
      <table class="table">
        <thead><tr><th>Item</th><th></th><th></th><th></th></tr></thead>
        <tbody>${items}</tbody>
      </table>
    </div>`;
}
