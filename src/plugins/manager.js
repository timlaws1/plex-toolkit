import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { validateManifest, isSafeArchivePath } from './manifest.js';

/**
 * Minimal tar extractor for GitHub archive downloads (ustar).
 * Only extracts regular files; rejects path traversal.
 */
async function extractTarGz(buffer, destDir) {
  const { PassThrough } = await import('node:stream');
  const gunzip = createGunzip();
  const input = Readable.from(buffer);
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  await pipeline(input, gunzip, out);
  const data = Buffer.concat(chunks);

  let offset = 0;
  /** @type {string|null} */
  let stripPrefix = null;

  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;

    const name = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const sizeOctal = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim();
    const typeFlag = String.fromCharCode(header[156]);
    const size = parseInt(sizeOctal, 8) || 0;
    const content = data.subarray(offset, offset + size);
    offset += size;
    if (size % 512 !== 0) offset += 512 - (size % 512);

    if (!name) continue;
    if (stripPrefix == null) {
      const first = name.split('/')[0];
      stripPrefix = first ? `${first}/` : '';
    }
    let rel = name;
    if (stripPrefix && rel.startsWith(stripPrefix)) {
      rel = rel.slice(stripPrefix.length);
    }
    if (!rel || rel.endsWith('/')) continue;
    if (!isSafeArchivePath(rel)) {
      throw new Error(`Unsafe archive path: ${name}`);
    }
    if (typeFlag !== '0' && typeFlag !== '\0') continue;

    const target = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

export class PluginManager {
  constructor({
    pluginsDir,
    toolsDir = null,
    db,
    runtime,
    logger,
    pluginLocalRoots = [],
    secrets = null,
  }) {
    this.pluginsDir = pluginsDir;
    this.toolsDir = toolsDir ? path.resolve(toolsDir) : null;
    this.db = db;
    this.runtime = runtime;
    this.logger = logger;
    this.pluginLocalRoots = pluginLocalRoots.map((p) => path.resolve(p));
    this.secrets = secrets;
  }

  /**
   * Copy tools from the image/repo `tools/` folder into data/plugins on every
   * boot so bundled code cannot be replaced by a tampered volume copy.
   * Preserves settings and the user's enabled flag; removes tools no longer
   * shipped in the image.
   */
  async syncBundled() {
    if (!this.toolsDir || !fs.existsSync(this.toolsDir)) {
      this.logger.warn('No bundled tools directory found');
      return;
    }

    const bundledIds = new Set();
    const entries = fs.readdirSync(this.toolsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const srcDir = path.join(this.toolsDir, entry.name);
      let manifest;
      try {
        manifest = this._readAndValidate(srcDir);
      } catch (err) {
        this.logger.error(
          `Skipping invalid bundled tool ${entry.name}: ${err.message}`,
        );
        continue;
      }
      bundledIds.add(manifest.id);

      const dest = this.pluginPath(manifest.id);
      const existing = dbGet(this.db, manifest.id);

      if (this.runtime.isActive(manifest.id)) {
        await this.runtime.deactivate(manifest.id);
      }
      if (fs.existsSync(dest)) rmrf(dest);
      copyDir(srcDir, dest);
      this.logger.info(
        `Synced bundled tool ${manifest.id}@${manifest.version}`,
        { pluginId: manifest.id },
      );

      if (!existing) {
        this._upsertDb(manifest, {
          source_type: 'bundled',
          source_url: srcDir,
          enabled: 1,
        });
      } else {
        this.db
          .prepare(
            `UPDATE plugins SET
               name = ?,
               version = ?,
               author = ?,
               description = ?,
               source_type = 'bundled',
               source_url = ?,
               permissions = ?,
               updated_at = datetime('now'),
               last_error = NULL
             WHERE id = ?`,
          )
          .run(
            manifest.name,
            manifest.version,
            manifest.author,
            manifest.description,
            srcDir,
            JSON.stringify(manifest.permissions),
            manifest.id,
          );
      }
    }

    for (const row of this.listInstalled()) {
      if (!bundledIds.has(row.id)) {
        this.logger.info(`Removing tool not in image: ${row.id}`, {
          pluginId: row.id,
        });
        await this.remove(row.id);
      }
    }
  }

  pluginPath(id) {
    return path.join(this.pluginsDir, id);
  }

  listInstalled() {
    return this.db
      .prepare('SELECT * FROM plugins ORDER BY name ASC')
      .all()
      .map((row) => ({
        ...row,
        enabled: Boolean(row.enabled),
        permissions: JSON.parse(row.permissions || '[]'),
        active: this.runtime.isActive(row.id),
      }));
  }

  get(id) {
    const row = dbGet(this.db, id);
    if (!row) return null;
    return {
      ...row,
      enabled: Boolean(row.enabled),
      permissions: JSON.parse(row.permissions || '[]'),
      active: this.runtime.isActive(row.id),
    };
  }

  async loadEnabled() {
    const rows = this.db
      .prepare('SELECT * FROM plugins WHERE enabled = 1')
      .all();
    for (const row of rows) {
      try {
        await this.runtime.activate(
          { ...row, entry: this._entryFromDisk(row.id) },
          this.pluginPath(row.id),
        );
      } catch (err) {
        this.logger.error(`Failed to activate ${row.id}: ${err.message}`, {
          pluginId: row.id,
        });
        this.db
          .prepare('UPDATE plugins SET last_error = ? WHERE id = ?')
          .run(err.message, row.id);
      }
    }
  }

  _entryFromDisk(id) {
    const manifestPath = path.join(this.pluginPath(id), 'plugin.json');
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return raw.entry || 'plugin.js';
  }

  _readAndValidate(dir) {
    const manifestPath = path.join(dir, 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('plugin.json not found');
    }
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const result = validateManifest(raw, { pluginRoot: dir });
    if (!result.ok) {
      throw new Error(`Invalid plugin manifest: ${result.errors.join('; ')}`);
    }
    const entryPath = path.join(dir, result.manifest.entry);
    if (!fs.existsSync(entryPath)) {
      throw new Error(`Entry file missing: ${result.manifest.entry}`);
    }
    return result.manifest;
  }

  isAllowedLocalPath(candidate) {
    const resolved = path.resolve(candidate);
    return this.pluginLocalRoots.some((root) => {
      const r = path.resolve(root);
      return resolved === r || resolved.startsWith(r + path.sep);
    });
  }

  async installFromLocal(localPath, { enable = true } = {}) {
    const resolved = path.resolve(localPath);
    if (!this.isAllowedLocalPath(resolved)) {
      throw new Error(
        'Local path is not under PLUGIN_LOCAL_ROOTS. Refusing install.',
      );
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error('Local plugin path must be a directory');
    }
    const manifest = this._readAndValidate(resolved);
    const dest = this.pluginPath(manifest.id);
    if (fs.existsSync(dest)) rmrf(dest);
    copyDir(resolved, dest);
    this._upsertDb(manifest, {
      source_type: 'local',
      source_url: resolved,
      enabled: enable ? 1 : 0,
    });
    if (enable) {
      await this.enable(manifest.id);
    }
    return this.get(manifest.id);
  }

  async installFromGithub(repoUrl, { ref = 'main', enable = true } = {}) {
    const parsed = parseGithubRepo(repoUrl);
    if (!parsed) throw new Error('Invalid GitHub repository URL');
    const archiveUrl = `https://github.com/${parsed.owner}/${parsed.repo}/archive/refs/heads/${ref}.tar.gz`;
    this.logger.info(`Downloading plugin from ${archiveUrl}`);

    let res = await fetch(archiveUrl, {
      headers: { 'User-Agent': 'plex-toolkit' },
      redirect: 'follow',
    });
    if (!res.ok && ref === 'main') {
      const masterUrl = `https://github.com/${parsed.owner}/${parsed.repo}/archive/refs/heads/master.tar.gz`;
      res = await fetch(masterUrl, {
        headers: { 'User-Agent': 'plex-toolkit' },
        redirect: 'follow',
      });
    }
    if (!res.ok) {
      throw new Error(`Failed to download plugin archive: HTTP ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const tmp = path.join(this.pluginsDir, `.tmp-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      await extractTarGz(buffer, tmp);
      const manifest = this._readAndValidate(tmp);
      const dest = this.pluginPath(manifest.id);
      if (this.runtime.isActive(manifest.id)) {
        await this.runtime.deactivate(manifest.id);
      }
      if (fs.existsSync(dest)) rmrf(dest);
      fs.renameSync(tmp, dest);
      this._upsertDb(manifest, {
        source_type: 'github',
        source_url: `https://github.com/${parsed.owner}/${parsed.repo}`,
        enabled: enable ? 1 : 0,
      });
      if (enable) {
        await this.enable(manifest.id);
      }
      return this.get(manifest.id);
    } catch (err) {
      rmrf(tmp);
      throw err;
    }
  }

  async update(id) {
    const row = dbGet(this.db, id);
    if (!row) throw new Error('Plugin not found');
    const wasEnabled = Boolean(row.enabled);
    if (row.source_type === 'github' && row.source_url) {
      await this.installFromGithub(row.source_url, { enable: wasEnabled });
    } else if (row.source_type === 'local' && row.source_url) {
      await this.installFromLocal(row.source_url, { enable: wasEnabled });
    } else {
      throw new Error('Cannot update plugin without a known source');
    }
    return this.get(id);
  }

  async enable(id) {
    const row = dbGet(this.db, id);
    if (!row) throw new Error('Plugin not found');
    const entry = this._entryFromDisk(id);
    await this.runtime.activate({ ...row, entry }, this.pluginPath(id));
    this.db
      .prepare(
        `UPDATE plugins SET enabled = 1, last_error = NULL, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(id);
    return this.get(id);
  }

  async disable(id) {
    await this.runtime.deactivate(id);
    this.db
      .prepare(
        `UPDATE plugins SET enabled = 0, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(id);
    return this.get(id);
  }

  async remove(id) {
    await this.runtime.deactivate(id);
    this.db.prepare('DELETE FROM plugin_settings WHERE plugin_id = ?').run(id);
    this.db.prepare('DELETE FROM plugin_storage WHERE plugin_id = ?').run(id);
    this.db.prepare('DELETE FROM plugins WHERE id = ?').run(id);
    rmrf(this.pluginPath(id));
    // Keep change_batches / activity for audit
  }

  saveSettings(id, settings) {
    const manifest = this.getManifest(id) || {};
    const schema = Array.isArray(manifest.settingsSchema)
      ? manifest.settingsSchema
      : [];
    const schemaByKey = new Map(schema.map((f) => [f.key, f]));
    const existing = this.getSettingsRaw(id);

    const upsert = this.db.prepare(
      `INSERT INTO plugin_settings (plugin_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value`,
    );
    const tx = this.db.transaction((obj) => {
      for (const [key, value] of Object.entries(obj)) {
        const field = schemaByKey.get(key);
        let stored = value;
        if (field?.type === 'secret' && this.secrets) {
          const plain = value == null ? '' : String(value);
          if (plain === '' && existing[key]) {
            // Keep previous secret when the form field is left blank
            continue;
          }
          stored = plain === '' ? '' : this.secrets.encrypt(plain);
        }
        upsert.run(id, key, JSON.stringify(stored));
      }
    });
    tx(settings);
  }

  getSettingsRaw(id) {
    const rows = this.db
      .prepare('SELECT key, value FROM plugin_settings WHERE plugin_id = ?')
      .all(id);
    const out = {};
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        out[row.key] = row.value;
      }
    }
    return out;
  }

  getSettings(id, { forDisplay = false } = {}) {
    const manifest = this.getManifest(id) || {};
    const schema = Array.isArray(manifest.settingsSchema)
      ? manifest.settingsSchema
      : [];
    const schemaByKey = new Map(schema.map((f) => [f.key, f]));
    const raw = this.getSettingsRaw(id);
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      const field = schemaByKey.get(key);
      if (field?.type === 'secret') {
        if (forDisplay) {
          out[key] = value ? '' : '';
          out[`${key}__set`] = Boolean(value);
        } else if (this.secrets && typeof value === 'string' && value) {
          try {
            out[key] = this.secrets.decrypt(value) ?? '';
          } catch {
            out[key] = '';
          }
        } else {
          out[key] = '';
        }
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  getManifest(id) {
    const p = path.join(this.pluginPath(id), 'plugin.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }

  _upsertDb(manifest, { source_type, source_url, enabled }) {
    this.db
      .prepare(
        `INSERT INTO plugins
         (id, name, version, author, description, source_type, source_url, enabled, permissions, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           version = excluded.version,
           author = excluded.author,
           description = excluded.description,
           source_type = excluded.source_type,
           source_url = excluded.source_url,
           enabled = excluded.enabled,
           permissions = excluded.permissions,
           updated_at = datetime('now'),
           last_error = NULL`,
      )
      .run(
        manifest.id,
        manifest.name,
        manifest.version,
        manifest.author,
        manifest.description,
        source_type,
        source_url,
        enabled,
        JSON.stringify(manifest.permissions),
      );
  }
}

function dbGet(db, id) {
  return db.prepare('SELECT * FROM plugins WHERE id = ?').get(id);
}

export function parseGithubRepo(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim().replace(/\.git$/, '');
  const m = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)(?:\/.*)?$/i,
  );
  if (m) return { owner: m[1], repo: m[2] };
  const short = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (short) return { owner: short[1], repo: short[2] };
  return null;
}
