import { getSetting, setSetting } from '../db/index.js';

const KEY = 'tmdb';
const LEGACY_PLUGINS = ['plex-notifier', 'scheduled-recommendations', 'trailer-fetcher'];

/**
 * Host-wide TMDb API key shared by every tool. Stored encrypted.
 * @returns {{ apiKey: string }}
 */
export function loadTmdbSettings(db, secrets) {
  const raw = getSetting(db, KEY, {}) || {};
  let apiKey = '';
  if (raw.apiKeyEncrypted && secrets) {
    try {
      apiKey = secrets.decrypt(raw.apiKeyEncrypted) ?? '';
    } catch {
      apiKey = '';
    }
  }
  return { apiKey };
}

export function tmdbConfigured(settings) {
  return Boolean(settings.apiKey);
}

/**
 * @param {object} input form values; blank `apiKey` keeps the stored key unless `clear` is set
 */
export function saveTmdbSettings(db, secrets, input) {
  const existing = getSetting(db, KEY, {}) || {};
  const apiKey = String(input.apiKey || '').trim();
  const clear = input.clear === true || input.clear === '1' || input.clear === 'on';
  setSetting(db, KEY, {
    apiKeyEncrypted: apiKey ? secrets.encrypt(apiKey) : clear ? null : existing.apiKeyEncrypted || null,
  });
}

/**
 * Copy the first TMDb key saved on a tool into the shared setting once, when none is saved yet.
 */
export function migrateLegacyTmdb(db, secrets) {
  if (getSetting(db, KEY, null)) return false;
  const select = db.prepare(
    `SELECT value FROM plugin_settings WHERE plugin_id = ? AND key = 'tmdbApiKey'`,
  );
  for (const pluginId of LEGACY_PLUGINS) {
    const row = select.get(pluginId);
    if (!row) continue;
    let encrypted;
    try {
      encrypted = JSON.parse(row.value);
    } catch {
      encrypted = row.value;
    }
    if (typeof encrypted !== 'string' || !encrypted) continue;
    try {
      if (!secrets.decrypt(encrypted)) continue;
    } catch {
      continue;
    }
    setSetting(db, KEY, { apiKeyEncrypted: encrypted });
    return true;
  }
  return false;
}
