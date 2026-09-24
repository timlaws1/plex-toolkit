import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { createLogger } from '../src/log.js';
import { PluginManager } from '../src/plugins/manager.js';
import { InProcessRuntime, Scheduler } from '../src/plugins/runtime.js';
import { EventBus } from '../src/events/bus.js';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pt-bundled-'));
}

function writeFixtureTool(toolsDir, { id, name, version }) {
  const dir = path.join(toolsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({
      id,
      name,
      version,
      apiVersion: 1,
      entry: 'plugin.js',
      permissions: ['storage'],
      description: `${name} fixture`,
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'plugin.js'),
    `export async function activate(ctx) {
  ctx.storage.set('booted', true);
}
export async function deactivate() {}
`,
  );
  return dir;
}

function createManager(root) {
  const pluginsDir = path.join(root, 'plugins');
  const toolsDir = path.join(root, 'tools');
  const logsDir = path.join(root, 'logs');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  const db = openDatabase(path.join(root, 'toolkit.sqlite'));
  const logger = createLogger(logsDir, db);
  const runtime = new InProcessRuntime({
    plex: {},
    bus: new EventBus(),
    db,
    logger,
    getConfiguredAccountId: () => null,
    panels: new Map(),
    scheduler: new Scheduler(logger),
  });
  const manager = new PluginManager({
    pluginsDir,
    toolsDir,
    db,
    runtime,
    logger,
  });
  return { manager, db, toolsDir, pluginsDir };
}

test('syncBundled does not install a tool that was never installed', async () => {
  const root = makeTempRoot();
  const { manager, toolsDir } = createManager(root);
  writeFixtureTool(toolsDir, {
    id: 'demo-tool',
    name: 'Demo Tool',
    version: '1.0.0',
  });

  await manager.syncBundled();

  assert.equal(manager.get('demo-tool'), null);
  assert.equal(
    fs.existsSync(path.join(manager.pluginPath('demo-tool'), 'plugin.js')),
    false,
  );
  const catalog = manager.listCatalog();
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].id, 'demo-tool');
  assert.equal(catalog[0].installed, false);
});

test('installBundled installs one tool disabled and sync refreshes it', async () => {
  const root = makeTempRoot();
  const { manager, toolsDir } = createManager(root);
  writeFixtureTool(toolsDir, {
    id: 'demo-tool',
    name: 'Demo Tool',
    version: '1.0.0',
  });

  const installed = await manager.installBundled('demo-tool');
  assert.equal(installed.enabled, false);
  assert.equal(installed.source_type, 'bundled');
  assert.equal(installed.version, '1.0.0');
  assert.equal(manager.listCatalog()[0].installed, true);

  writeFixtureTool(toolsDir, {
    id: 'demo-tool',
    name: 'Demo Tool',
    version: '1.1.0',
  });
  await manager.syncBundled();

  const row = manager.get('demo-tool');
  assert.equal(row.version, '1.1.0');
  assert.equal(row.enabled, false);
});

test('syncBundled upgrades code and preserves settings and enabled flag', async () => {
  const root = makeTempRoot();
  const { manager, toolsDir, db } = createManager(root);
  writeFixtureTool(toolsDir, {
    id: 'demo-tool',
    name: 'Demo Tool',
    version: '1.0.0',
  });
  await manager.installBundled('demo-tool');
  manager.saveSettings('demo-tool', { note: 'keep-me' });
  await manager.enable('demo-tool');
  await manager.disable('demo-tool');

  writeFixtureTool(toolsDir, {
    id: 'demo-tool',
    name: 'Demo Tool',
    version: '1.1.0',
  });
  await manager.syncBundled();

  const row = manager.get('demo-tool');
  assert.equal(row.version, '1.1.0');
  assert.equal(row.enabled, false);
  assert.equal(manager.getSettings('demo-tool').note, 'keep-me');
  const settingRow = db
    .prepare(
      'SELECT value FROM plugin_settings WHERE plugin_id = ? AND key = ?',
    )
    .get('demo-tool', 'note');
  assert.ok(settingRow);
});

test('syncBundled overwrites tampered tool code even when version is unchanged', async () => {
  const root = makeTempRoot();
  const { manager, toolsDir } = createManager(root);
  writeFixtureTool(toolsDir, {
    id: 'demo-tool',
    name: 'Demo Tool',
    version: '1.0.0',
  });
  await manager.installBundled('demo-tool');

  const entry = path.join(manager.pluginPath('demo-tool'), 'plugin.js');
  fs.writeFileSync(
    entry,
    'export async function activate() { throw new Error("tampered"); }\n',
  );
  assert.match(fs.readFileSync(entry, 'utf8'), /tampered/);

  await manager.syncBundled();
  const restored = fs.readFileSync(entry, 'utf8');
  assert.doesNotMatch(restored, /tampered/);
  assert.match(restored, /storage\.set\('booted'/);
});

test('syncBundled removes tools that are not in the image (e.g. crate)', async () => {
  const root = makeTempRoot();
  const { manager, toolsDir, pluginsDir } = createManager(root);
  writeFixtureTool(toolsDir, {
    id: 'demo-tool',
    name: 'Demo Tool',
    version: '1.0.0',
  });
  await manager.installBundled('demo-tool');

  const crateDir = path.join(pluginsDir, 'crate');
  fs.mkdirSync(crateDir, { recursive: true });
  fs.writeFileSync(
    path.join(crateDir, 'plugin.json'),
    JSON.stringify({
      id: 'crate',
      name: 'Crate',
      version: '1.0.0',
      apiVersion: 1,
      entry: 'plugin.js',
      permissions: [],
    }),
  );
  fs.writeFileSync(
    path.join(crateDir, 'plugin.js'),
    'export async function activate() {}',
  );
  manager._upsertDb(
    {
      id: 'crate',
      name: 'Crate',
      version: '1.0.0',
      author: null,
      description: '',
      permissions: [],
    },
    { source_type: 'local', source_url: crateDir, enabled: 1 },
  );

  assert.ok(manager.get('crate'));
  await manager.syncBundled();
  assert.equal(manager.get('crate'), null);
  assert.equal(fs.existsSync(crateDir), false);
  assert.ok(manager.get('demo-tool'));
});
