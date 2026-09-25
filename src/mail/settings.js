import { getSetting, setSetting } from '../db/index.js';

const KEY = 'mail';
const LEGACY_PLUGIN = 'plex-notifier';

/**
 * Host-wide outgoing mail settings. The password is stored encrypted.
 * @returns {{ host: string, port: number, user: string, pass: string, from: string, to: string, secure: boolean }}
 */
export function loadMailSettings(db, secrets) {
  const raw = getSetting(db, KEY, {}) || {};
  let pass = '';
  if (raw.passEncrypted && secrets) {
    try {
      pass = secrets.decrypt(raw.passEncrypted) ?? '';
    } catch {
      pass = '';
    }
  }
  const port = Number(raw.port) || 587;
  return {
    host: String(raw.host || ''),
    port,
    user: String(raw.user || ''),
    pass,
    from: String(raw.from || ''),
    to: String(raw.to || ''),
    secure: raw.secure === true || port === 465,
  };
}

export function mailConfigured(settings) {
  return Boolean(settings.host && settings.from);
}

/**
 * @param {object} input form values; blank `pass` keeps the stored password
 */
export function saveMailSettings(db, secrets, input) {
  const existing = getSetting(db, KEY, {}) || {};
  const pass = String(input.pass || '');
  setSetting(db, KEY, {
    host: String(input.host || '').trim(),
    port: Number(input.port) || 587,
    user: String(input.user || '').trim(),
    passEncrypted: pass ? secrets.encrypt(pass) : existing.passEncrypted || null,
    from: String(input.from || '').trim(),
    to: String(input.to || '').trim(),
    secure: input.secure === true || input.secure === '1' || input.secure === 'on',
  });
}

/**
 * Copy SMTP fields saved on Plex Notifier into core mail once, when core mail is empty.
 */
export function migrateLegacyMail(db, secrets) {
  if (getSetting(db, KEY, null)) return false;
  const rows = db
    .prepare('SELECT key, value FROM plugin_settings WHERE plugin_id = ?')
    .all(LEGACY_PLUGIN);
  const legacy = {};
  for (const row of rows) {
    try {
      legacy[row.key] = JSON.parse(row.value);
    } catch {
      legacy[row.key] = row.value;
    }
  }
  if (!legacy.smtpHost) return false;
  setSetting(db, KEY, {
    host: String(legacy.smtpHost || '').trim(),
    port: Number(legacy.smtpPort) || 587,
    user: String(legacy.smtpUser || '').trim(),
    passEncrypted: typeof legacy.smtpPassword === 'string' && legacy.smtpPassword ? legacy.smtpPassword : null,
    from: String(legacy.smtpFrom || '').trim(),
    to: String(legacy.smtpTo || '').trim(),
    secure: legacy.smtpSecure === true,
  });
  return true;
}
