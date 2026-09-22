import fs from 'node:fs';
import path from 'node:path';

export function createLogger(logsDir, db = null) {
  fs.mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, 'toolkit.log');

  function write(level, message, meta = {}) {
    const line = `${new Date().toISOString()} [${level}] ${message}${
      Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : ''
    }\n`;
    try {
      fs.appendFileSync(filePath, line);
    } catch {
      // ignore disk errors for logging
    }
    const fn = level === 'error' ? console.error : console.log;
    fn(line.trimEnd());
    if (db && meta.pluginId) {
      try {
        db.prepare(
          `INSERT INTO plugin_activity (plugin_id, level, message) VALUES (?, ?, ?)`,
        ).run(meta.pluginId, level, message);
      } catch {
        // ignore
      }
    }
  }

  return {
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    debug: (message, meta) => write('debug', message, meta),
    child(pluginId) {
      return {
        info: (message, meta = {}) =>
          write('info', message, { ...meta, pluginId }),
        warn: (message, meta = {}) =>
          write('warn', message, { ...meta, pluginId }),
        error: (message, meta = {}) =>
          write('error', message, { ...meta, pluginId }),
        debug: (message, meta = {}) =>
          write('debug', message, { ...meta, pluginId }),
      };
    },
  };
}
