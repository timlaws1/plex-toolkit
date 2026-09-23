import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

function resolveDataDir() {
  const raw = process.env.DATA_DIR || './data';
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

const dataDir = resolveDataDir();

export const config = {
  root: ROOT,
  port: Number(process.env.PORT || 8787),
  dataDir,
  configDir: path.join(dataDir, 'config'),
  databaseDir: path.join(dataDir, 'database'),
  pluginsDir: path.join(dataDir, 'plugins'),
  toolsDir: path.join(ROOT, 'tools'),
  logsDir: path.join(dataDir, 'logs'),
  dbPath: path.join(dataDir, 'database', 'toolkit.sqlite'),
  secretKeyPath: path.join(dataDir, 'config', 'secret.key'),
  clientIdPath: path.join(dataDir, 'config', 'client.id'),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  plexClientId: process.env.PLEX_CLIENT_ID || '',
  publicUrl: process.env.PUBLIC_URL || '',
};

export function ensureDataDirs() {
  for (const dir of [
    config.dataDir,
    config.configDir,
    config.databaseDir,
    config.pluginsDir,
    config.logsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
