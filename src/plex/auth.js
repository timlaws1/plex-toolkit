import fs from 'node:fs';
import crypto from 'node:crypto';

const PLEX_TV = 'https://plex.tv';
const PRODUCT = 'Plex Toolkit';
const VERSION = '1.0.0';

export function ensureClientId(clientIdPath, envClientId) {
  if (envClientId && String(envClientId).trim()) {
    return String(envClientId).trim();
  }
  if (fs.existsSync(clientIdPath)) {
    const existing = fs.readFileSync(clientIdPath, 'utf8').trim();
    if (existing) return existing;
  }
  const id = crypto.randomUUID();
  fs.mkdirSync(clientIdPath.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  fs.writeFileSync(clientIdPath, id, { mode: 0o600 });
  return id;
}

export function productHeaders(clientId, token) {
  const headers = {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': VERSION,
    'X-Plex-Client-Identifier': clientId,
    'X-Plex-Platform': 'Web',
    'X-Plex-Device': 'Plex Toolkit',
    'X-Plex-Device-Name': PRODUCT,
  };
  if (token) headers['X-Plex-Token'] = token;
  return headers;
}

/**
 * @returns {Promise<{id:number, code:string, authUrl:string}>}
 */
export async function createPin(clientId) {
  const res = await fetch(`${PLEX_TV}/api/v2/pins?strong=true`, {
    method: 'POST',
    headers: {
      ...productHeaders(clientId),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'strong=true',
  });
  if (!res.ok) {
    throw new Error(`Unable to start Plex authorization (HTTP ${res.status})`);
  }
  const data = await res.json();
  const id = Number(data.id);
  const code = String(data.code || '');
  if (!id || !code) throw new Error('Plex returned an invalid PIN');

  const params = new URLSearchParams({
    clientID: clientId,
    code,
    'context[device][product]': PRODUCT,
  });
  return {
    id,
    code,
    authUrl: `https://app.plex.tv/auth#?${params.toString()}`,
  };
}

export async function claimPinToken(clientId, pinId) {
  const res = await fetch(`${PLEX_TV}/api/v2/pins/${pinId}`, {
    headers: productHeaders(clientId),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const token = data.authToken;
  return typeof token === 'string' && token ? token : null;
}

/**
 * Poll for a claimed PIN token.
 */
export async function waitForPinToken(clientId, pinId, { attempts = 10, delayMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const token = await claimPinToken(clientId, pinId);
    if (token) return token;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

export async function fetchPlexAccount(clientId, token) {
  const res = await fetch(`${PLEX_TV}/api/v2/user`, {
    headers: productHeaders(clientId, token),
  });
  if (!res.ok) {
    throw new Error(`Unable to resolve Plex account (HTTP ${res.status})`);
  }
  const user = await res.json();
  return {
    id: user?.id != null ? String(user.id) : null,
    username: user?.username || user?.title || null,
    email: user?.email || null,
  };
}

/**
 * @returns {Promise<Array<{id:string, name:string, uri:string|null, uris:string[], owned:boolean, product:string|null}>>}
 */
export async function listServers(clientId, accessToken) {
  const url = new URL(`${PLEX_TV}/api/v2/resources`);
  url.searchParams.set('includeHttps', '1');
  url.searchParams.set('includeRelay', '1');

  const res = await fetch(url, {
    headers: productHeaders(clientId, accessToken),
  });
  if (!res.ok) {
    throw new Error(`Unable to list Plex servers (HTTP ${res.status})`);
  }
  const resources = await res.json();
  const servers = [];
  for (const resource of resources || []) {
    const provides = String(resource.provides || '');
    if (!provides.includes('server')) continue;
    const id = String(resource.clientIdentifier || '');
    if (!id) continue;
    const uris = rankConnectionUris(resource.connections || []);
    servers.push({
      id,
      name: String(resource.name || 'Plex Server'),
      uri: uris[0] || null,
      uris,
      owned: Boolean(resource.owned),
      product: resource.product || null,
      sourceTitle: resource.sourceTitle || null,
    });
  }
  return servers;
}

export function rankConnectionUris(connections) {
  if (!Array.isArray(connections)) return [];
  /** @type {Map<string, number>} */
  const scored = new Map();

  for (const connection of connections) {
    if (!connection || typeof connection !== 'object') continue;
    const local = Boolean(connection.local);
    const relay = Boolean(connection.relay);
    const ipv6 = Boolean(connection.IPv6);
    let score = 0;
    if (!local && !relay) score += 100;
    else if (!local && relay) score += 40;
    else score += 10;
    if (ipv6) score -= 20;

    const candidates = [];
    if (typeof connection.uri === 'string' && connection.uri) {
      candidates.push(connection.uri);
    }
    const address = String(connection.address || '');
    const port = Number(connection.port || 0);
    if (port > 0 && /^\d{1,3}(\.\d{1,3}){3}$/.test(address)) {
      candidates.push(`http://${address}:${port}`);
      candidates.push(`https://${address}:${port}`);
    }

    for (const uri of candidates) {
      let uriScore = score;
      if (uri.includes('.plex.direct')) uriScore -= 5;
      if (uri.startsWith('http://') && !uri.includes('.plex.direct')) uriScore += 3;
      scored.set(uri, Math.max(scored.get(uri) ?? Number.NEGATIVE_INFINITY, uriScore));
    }
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([uri]) => uri);
}

export async function pickReachableUri(clientId, accessToken, uris, timeoutMs = 4000) {
  for (const raw of [...new Set(uris.filter(Boolean))]) {
    const uri = String(raw).replace(/\/$/, '');
    if (!uri) continue;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${uri}/identity`, {
        headers: productHeaders(clientId, accessToken),
        signal: controller.signal,
      });
      if (res.ok) return uri;
    } catch {
      // try next
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
