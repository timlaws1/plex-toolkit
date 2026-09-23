import { config, ensureDataDirs } from './config.js';
import { openDatabase } from './db/index.js';
import { ensureSecretKey, createSecrets } from './crypto/secrets.js';
import { createLogger } from './log.js';
import { EventBus } from './events/bus.js';
import { PlexClient } from './plex/client.js';
import { ensureClientId } from './plex/auth.js';
import { PlexEventMonitor } from './plex/events.js';
import { PluginManager } from './plugins/manager.js';
import { InProcessRuntime, Scheduler } from './plugins/runtime.js';
import { createApp } from './http/app.js';

async function main() {
  if (!config.adminPassword) {
    console.error(
      'ADMIN_PASSWORD is required. Set it in the environment or .env file.',
    );
    process.exit(1);
  }

  ensureDataDirs();
  const db = openDatabase(config.dbPath);
  const log = createLogger(config.logsDir, db);

  const key = ensureSecretKey(config.secretKeyPath, process.env.SECRET_KEY);
  const secrets = createSecrets(key);
  const clientId = ensureClientId(config.clientIdPath, config.plexClientId);
  const bus = new EventBus();
  const panels = new Map();
  const scheduler = new Scheduler(log);

  const plex = new PlexClient({
    url: '',
    token: '',
    clientId,
    logger: log,
  });
  const serverRow = db
    .prepare('SELECT * FROM plex_servers ORDER BY id ASC LIMIT 1')
    .get();
  if (serverRow?.token_encrypted) {
    plex.setCredentials({
      url: serverRow.url || '',
      token: secrets.decrypt(serverRow.token_encrypted),
      clientId,
    });
  }

  function getConfiguredAccountId() {
    const row = db
      .prepare('SELECT plex_account_id FROM plex_servers ORDER BY id ASC LIMIT 1')
      .get();
    return row?.plex_account_id || null;
  }

  const runtime = new InProcessRuntime({
    plex,
    bus,
    db,
    logger: log,
    getConfiguredAccountId,
    panels,
    scheduler,
    secrets,
  });

  const pluginManager = new PluginManager({
    pluginsDir: config.pluginsDir,
    toolsDir: config.toolsDir,
    db,
    runtime,
    logger: log,
    secrets,
  });

  const eventMonitor = new PlexEventMonitor({ plex, bus, logger: log });

  const app = createApp({
    db,
    secrets,
    plex,
    pluginManager,
    eventMonitor,
    panels,
    logger: log,
    publicUrl: config.publicUrl,
  });

  await pluginManager.syncBundled();
  await pluginManager.loadEnabled();
  eventMonitor.start();

  app.listen(config.port, () => {
    log.info(`Plex Toolkit listening on http://0.0.0.0:${config.port}`);
  });

  async function shutdown() {
    log.info('Shutting down…');
    eventMonitor.stop();
    scheduler.clearAll();
    for (const p of pluginManager.listInstalled()) {
      if (p.active) await runtime.deactivate(p.id);
    }
    db.close();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
