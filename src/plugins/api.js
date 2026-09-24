import { sendMail } from '../mail/smtp.js';
import { browserFetch as defaultBrowserFetch } from '../net/browser-fetch.js';
import fs from 'node:fs';
import { assertPathAllowed } from './fs-scope.js';
import { allowlistForPermissions, createScopedSql, hasSqlPermission } from './sql-scope.js';
import { scanBucketFolder, readMp4DurationMsHost } from './fs-media.js';

const ALLOWED_EVENTS = new Set([
  'playback.started',
  'playback.progress',
  'playback.finished',
  'episode.watched',
  'movie.watched',
  'library.updated',
]);

export function createPluginApi({
  pluginId,
  permissions,
  plex,
  bus,
  db,
  logger,
  getConfiguredAccountId,
  panels,
  scheduler,
  secrets = null,
  settingsSchema = [],
  browserFetch = defaultBrowserFetch,
  mediaRoots = null,
}) {
  const perms = new Set(permissions || []);
  const unsubscribers = [];
  const log = logger.child(pluginId);
  const schemaByKey = new Map(
    (settingsSchema || []).map((field) => [field.key, field]),
  );
  const scopedSql = createScopedSql(db, allowlistForPermissions(perms));

  function requirePerm(name) {
    if (!perms.has(name)) {
      throw new Error(`Plugin ${pluginId} lacks permission: ${name}`);
    }
  }

  function guardPath(candidate) {
    return assertPathAllowed(candidate, mediaRoots);
  }

  function loadSettings() {
    const rows = db
      .prepare('SELECT key, value FROM plugin_settings WHERE plugin_id = ?')
      .all(pluginId);
    const out = {};
    for (const row of rows) {
      let value;
      try {
        value = JSON.parse(row.value);
      } catch {
        value = row.value;
      }
      const field = schemaByKey.get(row.key);
      if (field?.type === 'secret' && typeof value === 'string' && secrets) {
        try {
          out[row.key] = secrets.decrypt(value) ?? '';
        } catch {
          out[row.key] = '';
        }
      } else {
        out[row.key] = value;
      }
    }
    return out;
  }

  const api = {
    pluginId,
    log: {
      info: (msg, meta) => log.info(msg, meta),
      warn: (msg, meta) => log.warn(msg, meta),
      error: (msg, meta) => log.error(msg, meta),
      debug: (msg, meta) => log.debug(msg, meta),
    },
    settings: {
      get() {
        return loadSettings();
      },
    },
    fetch(url, init) {
      requirePerm('net.fetch');
      return browserFetch(url, init);
    },
    plex: {
      async getServer() {
        requirePerm('plex.read');
        return plex.getServer();
      },
      async getLibraries() {
        requirePerm('plex.read');
        return plex.getLibraries();
      },
      async refreshLibrary(sectionId) {
        requirePerm('plex.refresh');
        return plex.refreshLibrary(sectionId);
      },
      async getLibraryItems(libraryId, opts) {
        requirePerm('plex.read');
        return plex.getLibraryItems(libraryId, opts);
      },
      async getShows(libraryId) {
        requirePerm('plex.read');
        return plex.getShows(libraryId);
      },
      async getEpisodes(showRatingKey) {
        requirePerm('plex.read');
        return plex.getEpisodes(showRatingKey);
      },
      async getWatchState(ratingKey) {
        requirePerm('plex.watch_state');
        return plex.getWatchState(ratingKey);
      },
      async markWatched(ratingKey) {
        requirePerm('plex.watch_state');
        return plex.markWatched(ratingKey);
      },
      async markUnwatched(ratingKey) {
        requirePerm('plex.watch_state');
        return plex.markUnwatched(ratingKey);
      },
      async getMetadata(ratingKey) {
        requirePerm('plex.read');
        return plex.getMetadata(ratingKey);
      },
      async getWatchlist() {
        requirePerm('plex.discover');
        return plex.getWatchlist();
      },
      async addToWatchlist(ratingKey) {
        requirePerm('plex.discover');
        return plex.addToWatchlist(ratingKey);
      },
      async removeFromWatchlist(ratingKey) {
        requirePerm('plex.discover');
        return plex.removeFromWatchlist(ratingKey);
      },
      async listCollections(sectionId) {
        requirePerm('plex.collections');
        return plex.listCollections(sectionId);
      },
      async createCollection(options) {
        requirePerm('plex.collections');
        return plex.createCollection(options);
      },
      async addCollectionItems(collectionKey, ratingKeys) {
        requirePerm('plex.collections');
        return plex.addCollectionItems(collectionKey, ratingKeys);
      },
      async removeCollectionItem(collectionKey, ratingKey) {
        requirePerm('plex.collections');
        return plex.removeCollectionItem(collectionKey, ratingKey);
      },
      async getCollectionItems(collectionKey) {
        requirePerm('plex.collections');
        return plex.getCollectionItems(collectionKey);
      },
      async setItemSummary(ratingKey, summary) {
        requirePerm('plex.collections');
        return plex.setItemSummary(ratingKey, summary);
      },
      async createPlaylist(options) {
        requirePerm('plex.collections');
        return plex.createPlaylist(options);
      },
      async addPlaylistItems(playlistKey, ratingKeys) {
        requirePerm('plex.collections');
        return plex.addPlaylistItems(playlistKey, ratingKeys);
      },
      async removePlaylistItem(playlistKey, playlistItemId) {
        requirePerm('plex.collections');
        return plex.removePlaylistItem(playlistKey, playlistItemId);
      },
      async getPlaylistItems(playlistKey) {
        requirePerm('plex.collections');
        return plex.getPlaylistItems(playlistKey);
      },
      async searchDiscover(query, opts) {
        requirePerm('plex.discover');
        return plex.searchDiscover(query, opts);
      },
      async getDiscoverMetadata(ratingKeyOrPath) {
        requirePerm('plex.discover');
        return plex.getDiscoverMetadata(ratingKeyOrPath);
      },
      async getDvrs() {
        requirePerm('plex.dvr');
        return plex.getDvrs();
      },
      async getDvrChannels() {
        requirePerm('plex.dvr');
        return plex.getDvrChannels();
      },
      async getSubscriptions(opts) {
        requirePerm('plex.dvr');
        return plex.getSubscriptions(opts);
      },
      async getMediaProviders() {
        requirePerm('plex.dvr');
        return plex.getMediaProviders();
      },
      async getDvrMediaProviderId() {
        requirePerm('plex.dvr');
        return plex.getDvrMediaProviderId();
      },
      async getSubscriptionTemplates(guid) {
        requirePerm('plex.dvr');
        return plex.getSubscriptionTemplates(guid);
      },
      async createSubscription(options) {
        requirePerm('plex.dvr');
        return plex.createSubscription(options);
      },
      async createSubscriptionFromTemplate(parameters, opts) {
        requirePerm('plex.dvr');
        return plex.createSubscriptionFromTemplate(parameters, opts);
      },
      async getPreference(id) {
        requirePerm('plex.prefs');
        return plex.getPreference(id);
      },
      async setPreference(id, value) {
        requirePerm('plex.prefs');
        return plex.setPreference(id, value);
      },
      isConfigured() {
        return plex.isConfigured();
      },
    },
    fs: {
      listVideos(dir) {
        requirePerm('fs.read');
        const allowed = guardPath(dir);
        return scanBucketFolder(allowed);
      },
      createReadStream(absPath, opts) {
        requirePerm('fs.read');
        const allowed = guardPath(absPath);
        return fs.createReadStream(allowed, opts);
      },
      stat(absPath) {
        requirePerm('fs.read');
        const allowed = guardPath(absPath);
        return fs.statSync(allowed);
      },
      readMp4DurationMs(absPath) {
        requirePerm('fs.read');
        const allowed = guardPath(absPath);
        return readMp4DurationMsHost(allowed);
      },
      exists(absPath) {
        requirePerm('fs.read');
        try {
          const allowed = guardPath(absPath);
          return fs.existsSync(allowed);
        } catch {
          return false;
        }
      },
    },
    sql: {
      prepare(sql) {
        if (!hasSqlPermission(perms)) {
          throw new Error(`Plugin ${pluginId} lacks permission: sql`);
        }
        return scopedSql.prepare(sql);
      },
      exec(sql) {
        if (!hasSqlPermission(perms)) {
          throw new Error(`Plugin ${pluginId} lacks permission: sql`);
        }
        return scopedSql.exec(sql);
      },
      transaction(fn) {
        if (!hasSqlPermission(perms)) {
          throw new Error(`Plugin ${pluginId} lacks permission: sql`);
        }
        return scopedSql.transaction(fn);
      },
    },
    events: {
      on(event, handler) {
        requirePerm('events.subscribe');
        if (!ALLOWED_EVENTS.has(event)) {
          throw new Error(`Unknown event: ${event}`);
        }
        const wrapped = (payload) => {
          try {
            const configured = getConfiguredAccountId();
            if (
              payload?.accountId != null &&
              configured != null &&
              String(payload.accountId) !== String(configured) &&
              String(payload.accountId) !== '0'
            ) {
              return;
            }
            handler(payload);
          } catch (err) {
            log.error(`Event handler error (${event}): ${err.message}`);
          }
        };
        bus.on(event, wrapped);
        unsubscribers.push(() => bus.off(event, wrapped));
        return () => bus.off(event, wrapped);
      },
      off(event, handler) {
        bus.off(event, handler);
      },
    },
    storage: {
      get(key) {
        requirePerm('storage');
        const row = db
          .prepare(
            'SELECT value FROM plugin_storage WHERE plugin_id = ? AND key = ?',
          )
          .get(pluginId, key);
        if (!row) return null;
        try {
          return JSON.parse(row.value);
        } catch {
          return row.value;
        }
      },
      set(key, value) {
        requirePerm('storage');
        db.prepare(
          `INSERT INTO plugin_storage (plugin_id, key, value) VALUES (?, ?, ?)
           ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value`,
        ).run(pluginId, key, JSON.stringify(value));
      },
      delete(key) {
        requirePerm('storage');
        db.prepare(
          'DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?',
        ).run(pluginId, key);
      },
    },
    scheduler: {
      every(ms, fn, label = 'task') {
        requirePerm('scheduler');
        if (ms < 60_000) {
          throw new Error('Scheduler minimum interval is 60000ms');
        }
        return scheduler.every(pluginId, ms, fn, label);
      },
    },
    mail: {
      async send({ to, subject, text, html, from } = {}) {
        requirePerm('mail.send');
        const settings = loadSettings();
        const host = settings.smtpHost || settings.smtp_host;
        const port = Number(settings.smtpPort || settings.smtp_port || 587);
        const user = settings.smtpUser || settings.smtp_user || '';
        const pass = settings.smtpPassword || settings.smtp_password || '';
        const fromAddr =
          from ||
          settings.smtpFrom ||
          settings.smtp_from ||
          settings.mailFrom ||
          '';
        const toAddr =
          to || settings.smtpTo || settings.smtp_to || settings.mailTo || '';
        const secure =
          settings.smtpSecure === true ||
          settings.smtp_secure === true ||
          port === 465;

        return sendMail({
          host,
          port,
          secure,
          user,
          pass,
          from: fromAddr,
          to: toAddr,
          subject,
          text,
          html,
        });
      },
    },
    changes: {
      recordBatch({ title, summary, dryRun = false, changes, meta = {} }) {
        requirePerm('changes');
        const accountId = getConfiguredAccountId();
        const info = db
          .prepare(
            `INSERT INTO change_batches
             (plugin_id, plex_account_id, title, summary, dry_run, payload)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            pluginId,
            accountId,
            title,
            summary || null,
            dryRun ? 1 : 0,
            JSON.stringify({ changes, meta }),
          );
        return Number(info.lastInsertRowid);
      },
      list({ limit = 20 } = {}) {
        requirePerm('changes');
        return db
          .prepare(
            `SELECT * FROM change_batches WHERE plugin_id = ?
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(pluginId, limit)
          .map((row) => ({
            ...row,
            dry_run: Boolean(row.dry_run),
            undone: Boolean(row.undone),
            payload: JSON.parse(row.payload),
          }));
      },
      get(id) {
        requirePerm('changes');
        const row = db
          .prepare(
            'SELECT * FROM change_batches WHERE id = ? AND plugin_id = ?',
          )
          .get(id, pluginId);
        if (!row) return null;
        return {
          ...row,
          dry_run: Boolean(row.dry_run),
          undone: Boolean(row.undone),
          payload: JSON.parse(row.payload),
        };
      },
      markUndone(id) {
        requirePerm('changes');
        db.prepare(
          'UPDATE change_batches SET undone = 1 WHERE id = ? AND plugin_id = ?',
        ).run(id, pluginId);
      },
    },
    panels: {
      add(panel) {
        panels.set(pluginId, panel);
      },
    },
    _dispose() {
      for (const off of unsubscribers) off();
      unsubscribers.length = 0;
      panels.delete(pluginId);
      scheduler.clearPlugin(pluginId);
    },
  };

  return api;
}
