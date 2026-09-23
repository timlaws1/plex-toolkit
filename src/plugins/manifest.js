import path from 'node:path';

const KNOWN_PERMISSIONS = new Set([
  'plex.read',
  'plex.watch_state',
  'plex.discover',
  'plex.dvr',
  'plex.refresh',
  'events.subscribe',
  'storage',
  'scheduler',
  'changes',
  'mail.send',
  'net.fetch',
]);

export function validateManifest(raw, { pluginRoot } = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['Manifest must be a JSON object'], manifest: null };
  }

  const id = raw.id;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) {
    errors.push('id must be a kebab-case string (2-63 chars)');
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    errors.push('name is required');
  }
  if (typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+/.test(raw.version)) {
    errors.push('version must be semver-like (e.g. 1.0.0)');
  }
  if (raw.apiVersion !== 1) {
    errors.push('apiVersion must be 1');
  }
  const entry = raw.entry || 'plugin.js';
  if (typeof entry !== 'string' || !entry.trim()) {
    errors.push('entry must be a relative file path');
  } else if (
    path.isAbsolute(entry) ||
    entry.includes('..') ||
    entry.startsWith('/') ||
    entry.startsWith('\\')
  ) {
    errors.push('entry must be a relative path inside the plugin directory');
  }

  const permissions = Array.isArray(raw.permissions) ? raw.permissions : [];
  for (const p of permissions) {
    if (!KNOWN_PERMISSIONS.has(p)) {
      errors.push(`unknown permission: ${p}`);
    }
  }

  if (pluginRoot) {
    const resolved = path.resolve(pluginRoot, entry);
    if (!resolved.startsWith(path.resolve(pluginRoot) + path.sep) && resolved !== path.resolve(pluginRoot)) {
      errors.push('entry escapes plugin directory');
    }
  }

  if (errors.length) {
    return { ok: false, errors, manifest: null };
  }

  return {
    ok: true,
    errors: [],
    manifest: {
      id,
      name: raw.name.trim(),
      version: raw.version,
      author: raw.author || null,
      description: raw.description || '',
      apiVersion: 1,
      entry,
      permissions,
      settingsSchema: Array.isArray(raw.settingsSchema) ? raw.settingsSchema : [],
      homepage: raw.homepage || null,
    },
  };
}

export function isSafeArchivePath(entryPath) {
  if (!entryPath || typeof entryPath !== 'string') return false;
  const normalized = entryPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false;
  const parts = normalized.split('/');
  if (parts.some((p) => p === '..')) return false;
  return true;
}

export { KNOWN_PERMISSIONS };
