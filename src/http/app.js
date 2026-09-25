import {
  layout,
  escapeHtml,
  pageHeader,
  renderGroupedSettings,
} from './views/layout.js';
import { getSetting, setSetting } from '../db/index.js';
import { loadMailSettings, mailConfigured, saveMailSettings } from '../mail/settings.js';
import { sendMail } from '../mail/smtp.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  createPin,
  waitForPinToken,
  listServers,
  pickReachableUri,
  fetchPlexAccount,
} from '../plex/auth.js';
import { startUpdate } from '../update/apply.js';
import { getUpdateStatus, readUpdateResult, refreshUpdateStatus } from '../update/status.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export function createApp(ctx) {
  const {
    db,
    secrets,
    plex,
    pluginManager,
    eventMonitor,
    panels,
    logger,
    publicUrl,
  } = ctx;

  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '15mb' }));
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

  function pinnedTools() {
    return db
      .prepare('SELECT id, name FROM plugins WHERE pinned = 1 AND enabled = 1 ORDER BY name ASC')
      .all()
      .map((row) => {
        const mod = pluginManager.runtime.getModule(row.id);
        const hasApp =
          typeof mod?.handleRequest === 'function' ||
          typeof mod?.default?.handleRequest === 'function';
        const base = `/plugins/${encodeURIComponent(row.id)}`;
        return { id: row.id, name: row.name, href: hasApp ? `${base}/app` : base };
      });
  }

  function render(req, res, { title, nav, body }) {
    res.send(
      layout({
        title,
        nav,
        body,
        flash: takeFlash(req, res),
        user: req.user,
        version: req.user ? getUpdateStatus() : null,
        pinned: req.user ? pinnedTools() : [],
        currentPath: req.path,
      }),
    );
  }

  const versionTimer = setInterval(() => {
    refreshUpdateStatus().catch((err) => {
      logger.warn(`Update check failed: ${err.message}`);
    });
  }, 15 * 60 * 1000);
  versionTimer.unref?.();
  refreshUpdateStatus().catch((err) => {
    logger.warn(`Update check failed: ${err.message}`);
  });

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
      body: `<div class="login-wrap panel">
        ${pageHeader('Sign in', 'Enter the admin password for this toolkit.')}
        <form method="post" action="/login">
          <div class="field">
            <label for="password">Password</label>
            <input id="password" type="password" name="password" required autofocus />
          </div>
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

  app.get('/', requireAuth, async (req, res) => {
    await refreshUpdateStatus().catch((err) => {
      logger.warn(`Update check failed: ${err.message}`);
    });
    const version = getUpdateStatus();
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
      .map((p) => {
        const status = p.enabled
          ? p.active
            ? '<span class="badge ok">Active</span>'
            : '<span class="badge warn">Enabled</span>'
          : '<span class="badge">Disabled</span>';
        return `<a class="list-row" href="/plugins/${encodeURIComponent(p.id)}" style="text-decoration:none;color:inherit">
          <div>
            <strong>${escapeHtml(p.name)}</strong>
            <div class="muted" style="font-size:0.8rem;margin-top:0.2rem">v${escapeHtml(p.version)}</div>
          </div>
          <div>${status}</div>
        </a>`;
      })
      .join('') || '<p class="muted">No tools installed yet.</p>';

    const activityRows = activity
      .map(
        (a) => `<div class="feed-item">
          <span class="when">${escapeHtml(a.created_at)}</span>
          <div>
            <strong style="font-size:0.9rem">${escapeHtml(a.plugin_id || 'system')}</strong>
            <span class="muted"> · ${escapeHtml(a.level)}</span>
            <div class="muted" style="margin-top:0.15rem">${escapeHtml(a.message)}</div>
          </div>
        </div>`,
      )
      .join('') || '<p class="muted">No recent activity.</p>';

    render(req, res, {
      title: 'Home',
      nav: 'dashboard',
      body: `
        ${pageHeader('Home', 'Your Plex connection and tools at a glance.')}
        <div class="stat-grid">
          <div class="stat-card">
            <div class="label">Plex</div>
            <div class="value" style="font-size:1.15rem;margin-top:0.5rem">${escapeHtml(server?.name || 'Not connected')}</div>
            <div class="hint">${statusBadge} · ${escapeHtml(server?.version || '—')}</div>
            ${server?.last_error ? `<div class="hint" style="color:var(--color-err)">${escapeHtml(server.last_error)}</div>` : ''}
          </div>
          <div class="stat-card">
            <div class="label">Tools</div>
            <div class="value">${plugins.length}</div>
            <div class="hint">${plugins.filter((p) => p.enabled).length} enabled</div>
          </div>
          <div class="stat-card">
            <div class="label">Version</div>
            <div class="value" style="font-size:1.15rem;margin-top:0.5rem">${escapeHtml(version.version)}</div>
            <div class="hint">${escapeHtml(version.revisionShort)} · ${escapeHtml(version.stateLabel)}</div>
            ${version.updateAvailable ? '<div class="hint"><a href="/update">Update</a></div>' : ''}
          </div>
          <div class="stat-card">
            <div class="label">Status</div>
            <div class="value" style="font-size:1.15rem;margin-top:0.5rem">${server?.last_ok_at ? 'Ready' : server ? 'Needs check' : 'Setup'}</div>
            <div class="hint"><a href="/plex">Manage Plex</a></div>
          </div>
        </div>

        <div class="panel" style="margin-top:1.25rem">
          <h2 class="panel-title">Tools</h2>
          <p class="panel-hint">Open a tool to change settings or use it.</p>
          <div class="list-stack">${pluginRows}</div>
        </div>

        <div class="panel" style="margin-top:1.25rem">
          <h2 class="panel-title">Recent activity</h2>
          <div class="feed">${activityRows}</div>
        </div>
      `,
    });
  });

  app.get('/update', requireAuth, async (req, res) => {
    const version = await refreshUpdateStatus(fetch, { force: true }).catch(() => getUpdateStatus());
    const result = readUpdateResult();
    const latestLine = version.updateAvailable
      ? `Newest build ${escapeHtml(version.latestShort)}${version.latestDate ? ` · ${escapeHtml(version.latestDate)}` : ''}.`
      : escapeHtml(version.stateLabel);
    const note = version.latestMessage
      ? `<p class="muted" style="margin-top:0.75rem">${escapeHtml(version.latestMessage)}</p>`
      : '';
    const outcome = result?.message
      ? `<p class="muted" style="margin-top:0.75rem">${escapeHtml(result.message)}</p>`
      : '';
    const action = version.updateAvailable && version.canApply
      ? `<form method="post" action="/update" style="margin-top:1rem">
          <button class="primary" type="submit">Update now</button>
        </form>`
      : version.updateAvailable
        ? `<div class="panel" style="margin-top:1rem">
            <h2 class="panel-title">One-click update</h2>
            <p class="panel-hint">Add the Docker socket so this screen can replace the container. Then recreate Plex Toolkit once.</p>
            <pre class="mono">group_add:
  - "\${DOCKER_GID}"
volumes:
  - /var/run/docker.sock:/var/run/docker.sock</pre>
            <p class="muted" style="margin-top:0.75rem">On the host, <span class="mono">DOCKER_GID</span> is the group that owns <span class="mono">/var/run/docker.sock</span>.</p>
            <p class="muted" style="margin-top:0.75rem">Or update from the host:</p>
            <pre class="mono">docker compose pull
docker compose up -d</pre>
          </div>`
        : '';

    render(req, res, {
      title: 'Update',
      nav: 'dashboard',
      body: `
        ${pageHeader('Update', `Running ${version.version} (${version.revisionShort}).`)}
        <div class="panel">
          <p>${latestLine}</p>
          ${note}
          ${outcome}
          ${action}
        </div>
      `,
    });
  });

  app.post('/update', requireAuth, async (req, res) => {
    const version = await refreshUpdateStatus().catch(() => getUpdateStatus());
    if (!version.updateAvailable) {
      flash(res, 'ok', 'Already on the newest build.');
      return res.redirect('/');
    }
    if (!version.canApply) {
      flash(res, 'error', 'The Docker socket is not available to this app.');
      return res.redirect('/update');
    }

    res.on('finish', () => {
      startUpdate().catch((err) => {
        logger.error(`Update failed to start: ${err.message}`);
      });
    });

    render(req, res, {
      title: 'Updating',
      nav: 'dashboard',
      body: `
        ${pageHeader('Updating', 'Pulling the newest image and restarting.')}
        <div class="panel">
          <p>This page will disconnect for a moment. Refresh Home when it comes back.</p>
        </div>
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
        ${pageHeader('Choose a Plex server', 'Your account is signed in. Pick which Media Server this toolkit should use.')}
        <div class="panel">
          <form method="post" action="/plex/select-server">
            <div class="field">
              <label for="server_id">Server</label>
              <select id="server_id" name="server_id" required>${options}</select>
            </div>
            <div class="row-actions">
              <button class="primary" type="submit">Connect server</button>
              <a class="btn" href="/plex/login">Cancel</a>
            </div>
          </form>
        </div>`;
    } else if (!server?.token_encrypted) {
      body = `
        ${pageHeader('Connect Plex', 'Sign in with your Plex account. The toolkit discovers your server — no token or URL to paste.')}
        <div class="panel">
          <form method="post" action="/plex/login">
            <div class="row-actions">
              <button class="primary" type="submit">Log in with Plex</button>
            </div>
          </form>
        </div>`;
    } else {
      const connected = Boolean(server.last_ok_at && server.url);
      const baseUrl = (publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
      const webhookUrl = `${baseUrl}/webhooks/plex`;
      const localOnly = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl);
      body = `
        ${pageHeader('Plex', connected ? 'Connected and ready for tools.' : 'Signed in — finish connecting your server.')}
        <div class="panel">
          <div style="display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;margin-bottom:0.75rem">
            ${
              connected
                ? '<span class="badge ok">Connected</span>'
                : '<span class="badge warn">Signed in</span>'
            }
            ${
              server.account_username
                ? `<span class="muted">as ${escapeHtml(server.account_username)}</span>`
                : ''
            }
          </div>
          <p style="font-size:1.35rem;font-weight:650;margin:0">${escapeHtml(server.name || 'Plex')}</p>
          <p class="muted" style="margin-top:0.35rem">Version ${escapeHtml(server.version || '—')} · Last OK ${escapeHtml(server.last_ok_at || '—')}</p>
          ${server.last_error ? `<p class="muted" style="margin-top:0.5rem;color:var(--color-err)">${escapeHtml(server.last_error)}</p>` : ''}
          <div class="row-actions">
            <form method="post" action="/plex/test"><button type="submit">Test connection</button></form>
            <form method="post" action="/plex/login"><button type="submit">Re-login</button></form>
            <form method="post" action="/plex/disconnect" onsubmit="return confirm('Disconnect Plex from this toolkit?')">
              <button class="danger" type="submit">Disconnect</button>
            </form>
          </div>
        </div>
        ${connected ? `<div class="panel">
          <h2 class="panel-title">Webhook</h2>
          <p class="panel-hint">Optional. In Plex, go to Settings → Webhooks, add this URL, and save. Tools already get playback events without it; webhooks add scrobble events (needs Plex Pass).</p>
          <div class="copy-row">
            <input id="webhook-url" type="text" class="mono" readonly value="${escapeHtml(webhookUrl)}" onclick="this.select()" />
            <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('webhook-url').value).then(() => { this.textContent = 'Copied'; setTimeout(() => { this.textContent = 'Copy'; }, 1500); })">Copy</button>
          </div>
          ${
            localOnly
              ? '<p class="field-help" style="margin-top:0.5rem;color:var(--color-warn)">This address only works on this computer. Set <span class="mono">PUBLIC_URL</span> to an address your Plex server can reach, for example <span class="mono">http://192.168.1.20:8787</span>.</p>'
              : ''
          }
        </div>` : ''}
        <details class="details-block">
          <summary>Connection details</summary>
          <div class="details-body">
            <div class="kv"><span class="k">Server URL</span><span class="mono">${escapeHtml(server.url || 'not set')}</span></div>
            <div class="kv"><span class="k">Machine ID</span><span class="mono">${escapeHtml(server.machine_id || '—')}</span></div>
            <div class="kv"><span class="k">Account ID</span><span class="mono">${escapeHtml(server.plex_account_id || '—')}</span></div>
          </div>
        </details>
        <details class="details-block">
          <summary>Server URL override</summary>
          <div class="details-body">
            <p class="muted" style="margin-bottom:0.75rem">Only needed if automatic discovery cannot reach your server.</p>
            <form method="post" action="/plex/server-url">
              <div class="field">
                <label for="url">Server URL</label>
                <input id="url" type="url" name="url" placeholder="http://192.168.1.10:32400" value="${escapeHtml(server.url || '')}" />
              </div>
              <div class="row-actions"><button type="submit">Save URL</button></div>
            </form>
          </div>
        </details>`;
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
        ${pageHeader('Authorize Plex', 'Approve Plex Toolkit in your browser, then continue here.')}
        <div class="panel">
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

  app.get('/mail', requireAuth, (req, res) => {
    const mail = loadMailSettings(db, secrets);
    const ready = mailConfigured(mail);
    render(req, res, {
      title: 'Mail',
      nav: 'mail',
      body: `
        ${pageHeader('Mail', 'One outgoing mail server for every tool that sends email.')}
        <form method="post" action="/mail">
          <section class="settings-section panel">
            <h2 class="panel-title">Server</h2>
            <div class="field-grid">
              <div class="field">
                <label for="mail-host">SMTP host</label>
                <input id="mail-host" type="text" name="host" value="${escapeHtml(mail.host)}" placeholder="smtp.example.com" />
              </div>
              <div class="field">
                <label for="mail-port">Port</label>
                <input id="mail-port" type="number" name="port" min="1" max="65535" value="${escapeHtml(mail.port)}" />
              </div>
            </div>
            <div class="field-grid" style="margin-top:1rem">
              <div class="field">
                <label for="mail-user">Username</label>
                <input id="mail-user" type="text" name="user" value="${escapeHtml(mail.user)}" autocomplete="off" />
              </div>
              <div class="field">
                <label for="mail-pass">Password</label>
                <input id="mail-pass" type="password" name="pass" value="" autocomplete="new-password" placeholder="${mail.pass ? '•••••••• (leave blank to keep)' : ''}" />
              </div>
            </div>
            <div class="toggle-row" style="margin-top:1rem">
              <div class="toggle-copy">
                <strong>Implicit TLS</strong>
                <span>Usually port 465. Leave off for STARTTLS on 587.</span>
              </div>
              <input type="checkbox" name="secure" value="1" ${mail.secure ? 'checked' : ''} />
            </div>
          </section>
          <section class="settings-section panel">
            <h2 class="panel-title">Addresses</h2>
            <div class="field-grid">
              <div class="field">
                <label for="mail-from">From</label>
                <input id="mail-from" type="email" name="from" value="${escapeHtml(mail.from)}" placeholder="toolkit@example.com" />
              </div>
              <div class="field">
                <label for="mail-to">Default recipient</label>
                <input id="mail-to" type="email" name="to" value="${escapeHtml(mail.to)}" placeholder="you@example.com" />
                <p class="field-help">Used when a tool does not set its own recipient.</p>
              </div>
            </div>
          </section>
          <div class="row-actions"><button class="primary" type="submit">Save mail settings</button></div>
        </form>
        <form method="post" action="/mail/test" style="margin-top:1rem">
          <div class="row-actions">
            <button type="submit" ${ready ? '' : 'disabled'}>Send test email</button>
            ${ready ? '' : '<span class="muted">Save a host and from address first.</span>'}
          </div>
        </form>
      `,
    });
  });

  app.post('/mail', requireAuth, (req, res) => {
    saveMailSettings(db, secrets, req.body || {});
    flash(res, 'ok', 'Mail settings saved');
    res.redirect('/mail');
  });

  app.post('/mail/test', requireAuth, async (req, res) => {
    const mail = loadMailSettings(db, secrets);
    try {
      if (!mailConfigured(mail)) throw new Error('Save a host and from address first');
      if (!mail.to) throw new Error('Add a default recipient to send a test');
      await sendMail({
        ...mail,
        subject: 'Plex Toolkit test email',
        text: 'Outgoing mail from Plex Toolkit is working.',
      });
      flash(res, 'ok', `Test email sent to ${mail.to}`);
    } catch (err) {
      flash(res, 'error', `Test email failed: ${err.message}`);
    }
    res.redirect('/mail');
  });

  app.get('/plugins', requireAuth, (req, res) => {
    const plugins = pluginManager.listInstalled();
    const catalog = pluginManager.listCatalog();
    const available = catalog.filter((c) => !c.installed);

    const installedRows =
      plugins
        .map((p) => {
          const status = p.enabled
            ? p.active
              ? '<span class="badge ok">Enabled</span>'
              : '<span class="badge warn">Enabled (inactive)</span>'
            : '<span class="badge">Disabled</span>';
          const mod = p.enabled ? pluginManager.runtime.getModule(p.id) : null;
          const hasApp =
            typeof mod?.handleRequest === 'function' ||
            typeof mod?.default?.handleRequest === 'function';
          return `<div class="plugin-row">
            <div>
              <strong>${escapeHtml(p.name)}</strong>
              <div style="margin-top:0.35rem">${status}</div>
              ${p.last_error ? `<div class="muted" style="margin-top:0.35rem;color:var(--color-err)">${escapeHtml(p.last_error)}</div>` : ''}
              <p class="muted" style="margin-top:0.5rem;max-width:36rem">${escapeHtml(p.description || '')}</p>
            </div>
            <div class="row-actions quiet">
              <form method="post" action="/plugins/${encodeURIComponent(p.id)}/pin">
                <button type="submit" class="ghost pin-btn${p.pinned ? ' pinned' : ''}" title="${p.pinned ? 'Unpin from nav' : 'Pin to nav'}" aria-label="${p.pinned ? 'Unpin from nav' : 'Pin to nav'}" aria-pressed="${p.pinned ? 'true' : 'false'}">
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M16 3a1 1 0 0 1 .7 1.7L15 6.4v4.2l2.7 2.7a1 1 0 0 1-.7 1.7h-4v5.5a1 1 0 0 1-2 0V15H7a1 1 0 0 1-.7-1.7L9 10.6V6.4L7.3 4.7A1 1 0 0 1 8 3h8Z"/></svg>
                </button>
              </form>
              ${
                hasApp
                  ? `<a class="btn primary" href="/plugins/${encodeURIComponent(p.id)}/app">Open</a>`
                  : ''
              }
              <a class="btn" href="/plugins/${encodeURIComponent(p.id)}">Settings</a>
              <form method="post" action="/plugins/${encodeURIComponent(p.id)}/${p.enabled ? 'disable' : 'enable'}">
                <button type="submit">${p.enabled ? 'Disable' : 'Enable'}</button>
              </form>
              <form method="post" action="/plugins/${encodeURIComponent(p.id)}/remove" onsubmit="return confirm('Remove this tool? Its settings will be deleted.')">
                <button type="submit" class="ghost">Remove</button>
              </form>
            </div>
          </div>`;
        })
        .join('') || '<p class="muted">No tools installed yet. Install one from the catalog below.</p>';

    const availableRows =
      available
        .map(
          (c) => `<div class="plugin-row">
            <div>
              <strong>${escapeHtml(c.name)}</strong>
              <div class="muted" style="font-size:0.8rem;margin-top:0.2rem">v${escapeHtml(c.version)}</div>
              <p class="muted" style="margin-top:0.5rem;max-width:36rem">${escapeHtml(c.description || '')}</p>
            </div>
            <div class="row-actions quiet">
              <form method="post" action="/plugins/${encodeURIComponent(c.id)}/install">
                <button type="submit" class="primary">Install</button>
              </form>
            </div>
          </div>`,
        )
        .join('') || '<p class="muted">All bundled tools are installed.</p>';

    render(req, res, {
      title: 'Tools',
      nav: 'plugins',
      body: `
        ${pageHeader('Tools', 'Install tools that use your shared Plex connection, then enable the ones you want.')}
        <div class="panel">
          <h2 style="margin:0 0 1rem;font-size:1rem">Installed</h2>
          ${installedRows}
        </div>
        <div class="panel" style="margin-top:1.25rem">
          <h2 style="margin:0 0 1rem;font-size:1rem">Available</h2>
          ${availableRows}
        </div>
      `,
    });
  });

  app.post('/plugins/:id/install', requireAuth, async (req, res) => {
    try {
      const plugin = await pluginManager.installBundled(req.params.id);
      flash(res, 'ok', `${plugin.name} installed. Enable it when you are ready.`);
      res.redirect(`/plugins/${encodeURIComponent(plugin.id)}`);
    } catch (err) {
      flash(res, 'error', err.message);
      res.redirect('/plugins');
    }
  });

  app.post('/plugins/:id/pin', requireAuth, (req, res) => {
    const plugin = pluginManager.get(req.params.id);
    if (!plugin) {
      flash(res, 'error', 'Plugin not found');
      return res.redirect('/plugins');
    }
    const pinned = plugin.pinned ? 0 : 1;
    db.prepare('UPDATE plugins SET pinned = ? WHERE id = ?').run(pinned, plugin.id);
    flash(
      res,
      'ok',
      pinned
        ? `${plugin.name} pinned${plugin.enabled ? '' : ' (shows in the nav once enabled)'}`
        : `${plugin.name} unpinned`,
    );
    res.redirect('/plugins');
  });

  app.post('/plugins/:id/remove', requireAuth, async (req, res) => {
    const plugin = pluginManager.get(req.params.id);
    if (!plugin) {
      flash(res, 'error', 'Plugin not found');
      return res.redirect('/plugins');
    }
    try {
      await pluginManager.remove(plugin.id);
      flash(res, 'ok', `${plugin.name} removed`);
    } catch (err) {
      flash(res, 'error', err.message);
    }
    res.redirect('/plugins');
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

    const fieldsHtml = renderGroupedSettings(schema, settings, libraries, shows);

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
      ? `<div class="row-actions quiet" style="margin-bottom:1rem">
          <a class="btn primary" href="/plugins/${encodeURIComponent(plugin.id)}/app">Open tool</a>
        </div>`
      : '';

    let customSettingsHtml = '';
    const settingsHtmlPath = path.join(
      pluginManager.pluginPath(plugin.id),
      'settings.html',
    );
    if (fs.existsSync(settingsHtmlPath)) {
      customSettingsHtml = `<div class="panel" style="padding:0;overflow:hidden;margin-top:1rem">
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
        ${pageHeader(plugin.name, plugin.description || `Version ${plugin.version}`)}
        ${appLink}
        <form method="post" action="/plugins/${encodeURIComponent(plugin.id)}/settings">
          ${fieldsHtml}
          <div class="row-actions"><button class="primary" type="submit">Save settings</button></div>
        </form>
        ${panelHtml}
        ${customSettingsHtml}
        <p style="margin-top:1.25rem"><a href="/plugins">← Back to tools</a></p>
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
      flash(res, 'ok', 'Tool enabled');
    } catch (err) {
      flash(res, 'error', err.message);
    }
    res.redirect('/plugins');
  });

  app.post('/plugins/:id/disable', requireAuth, async (req, res) => {
    try {
      await pluginManager.disable(req.params.id);
      flash(res, 'ok', 'Tool disabled');
    } catch (err) {
      flash(res, 'error', err.message);
    }
    res.redirect('/plugins');
  });

  app.post('/plugins/:id/panel/:action', requireAuth, async (req, res) => {
    const api = pluginManager.runtime.getApi(req.params.id);
    if (!api) {
      flash(res, 'error', 'Tool is not active');
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
      flash(res, 'error', 'This tool has no app page');
      return res.redirect(`/plugins/${encodeURIComponent(plugin.id)}`);
    }

    const api = pluginManager.runtime.getApi(plugin.id);
    try {
      const result = await handleRequest(api, {
        method: req.method,
        path: req.path,
        url: req.originalUrl || req.url,
        query: req.query || {},
        body: req.body || {},
        params: req.params,
        headers: req.headers || {},
      });

      if (result?.file) {
        return streamPluginFile(req, res, result);
      }

      if (result?.status === 404) {
        res.status(404).send(result.body || 'Not found');
        return;
      }

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
          <p style="margin-top:1.5rem"><a href="/plugins/${encodeURIComponent(plugin.id)}">← Tool settings</a></p>`,
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

  // Expose helpers for tests / index
  app.locals.ctx = ctx;
  void configuredAccountId;
  void getSetting;
  void setSetting;

  return app;
}

/**
 * Stream a local file returned by a plugin handleRequest ({ file, contentType, size }).
 */
function streamPluginFile(req, res, result) {
  const filePath = result.file;
  const total =
    result.size != null
      ? Number(result.size)
      : fs.statSync(filePath).size;
  const contentType = result.contentType || 'application/octet-stream';
  const range = req.headers.range;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      res.status(416).end();
      return;
    }
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Number(m[2]) : total - 1;
    if (start >= total || end >= total || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.setHeader('Content-Length', total);
  fs.createReadStream(filePath).pipe(res);
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
      return `<div class="list-row">
        <div>
          <strong>${escapeHtml(item.title)}</strong>
          ${item.subtitle ? `<div class="muted" style="font-size:0.8rem;margin-top:0.2rem">${escapeHtml(item.subtitle)}</div>` : ''}
          ${item.meta ? `<div class="muted" style="font-size:0.75rem;margin-top:0.15rem">${escapeHtml(item.meta)}</div>` : ''}
        </div>
        <div class="row-actions quiet">${actions}</div>
      </div>`;
    })
    .join('') || `<p class="muted">${escapeHtml(panel.empty || 'Nothing yet')}</p>`;

  return `<div class="panel" style="margin-top:1.25rem">
      <h2 class="panel-title">${escapeHtml(panel.title || 'Plugin panel')}</h2>
      <div class="list-stack">${items}</div>
    </div>`;
}
