import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPluginApi } from './api.js';

/**
 * In-process loader. Interface is replaceable with a worker-based runtime later.
 */
export class InProcessRuntime {
  constructor({
    plex,
    bus,
    db,
    logger,
    getConfiguredAccountId,
    panels,
    scheduler,
    secrets = null,
  }) {
    this.plex = plex;
    this.bus = bus;
    this.db = db;
    this.logger = logger;
    this.getConfiguredAccountId = getConfiguredAccountId;
    this.panels = panels;
    this.scheduler = scheduler;
    this.secrets = secrets;
    /** @type {Map<string, { module: any, api: any }>} */
    this.active = new Map();
  }

  async activate(pluginRecord, pluginDir) {
    await this.deactivate(pluginRecord.id);

    const entry = path.join(pluginDir, pluginRecord.entry || 'plugin.js');
    // Cache-bust so updates reload
    const url = `${pathToFileURL(entry).href}?t=${Date.now()}`;
    const mod = await import(url);
    const activate =
      typeof mod.activate === 'function'
        ? mod.activate
        : typeof mod.default?.activate === 'function'
          ? mod.default.activate
          : null;
    if (!activate) {
      throw new Error(`Plugin ${pluginRecord.id} has no activate() export`);
    }

    const permissions = JSON.parse(pluginRecord.permissions || '[]');
    let settingsSchema = [];
    try {
      const manifestPath = path.join(pluginDir, 'plugin.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        settingsSchema = Array.isArray(manifest.settingsSchema)
          ? manifest.settingsSchema
          : [];
      }
    } catch {
      settingsSchema = [];
    }

    const api = createPluginApi({
      pluginId: pluginRecord.id,
      permissions,
      plex: this.plex,
      bus: this.bus,
      db: this.db,
      logger: this.logger,
      getConfiguredAccountId: this.getConfiguredAccountId,
      panels: this.panels,
      scheduler: this.scheduler,
      secrets: this.secrets,
      settingsSchema,
    });

    await activate(api);
    this.active.set(pluginRecord.id, { module: mod, api });
    this.logger.info(`Plugin activated: ${pluginRecord.id}`, {
      pluginId: pluginRecord.id,
    });
  }

  async deactivate(pluginId) {
    const current = this.active.get(pluginId);
    if (!current) return;
    try {
      const deactivate =
        current.module.deactivate || current.module.default?.deactivate;
      if (typeof deactivate === 'function') {
        await deactivate(current.api);
      }
    } catch (err) {
      this.logger.error(
        `Plugin deactivate error (${pluginId}): ${err.message}`,
        { pluginId },
      );
    }
    current.api._dispose();
    this.active.delete(pluginId);
    this.logger.info(`Plugin deactivated: ${pluginId}`, { pluginId });
  }

  isActive(pluginId) {
    return this.active.has(pluginId);
  }

  getApi(pluginId) {
    return this.active.get(pluginId)?.api || null;
  }

  getModule(pluginId) {
    return this.active.get(pluginId)?.module || null;
  }
}

export class Scheduler {
  constructor(logger) {
    this.logger = logger;
    /** @type {Map<string, Set<NodeJS.Timeout>>} */
    this.timers = new Map();
  }

  every(pluginId, ms, fn, label) {
    const id = setInterval(async () => {
      try {
        await fn();
      } catch (err) {
        this.logger.error(
          `Scheduler task failed (${pluginId}/${label}): ${err.message}`,
          { pluginId },
        );
      }
    }, ms);
    if (!this.timers.has(pluginId)) this.timers.set(pluginId, new Set());
    this.timers.get(pluginId).add(id);
    return () => {
      clearInterval(id);
      this.timers.get(pluginId)?.delete(id);
    };
  }

  clearPlugin(pluginId) {
    const set = this.timers.get(pluginId);
    if (!set) return;
    for (const id of set) clearInterval(id);
    this.timers.delete(pluginId);
  }

  clearAll() {
    for (const pluginId of [...this.timers.keys()]) {
      this.clearPlugin(pluginId);
    }
  }
}
