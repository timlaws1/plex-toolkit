import Database from 'better-sqlite3';
import fs from 'node:fs';

const MIGRATIONS = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plex_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  url TEXT NOT NULL,
  token_encrypted TEXT,
  plex_account_id TEXT,
  machine_id TEXT,
  version TEXT,
  connected_at TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  author TEXT,
  description TEXT,
  source_type TEXT NOT NULL,
  source_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL DEFAULT '[]',
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS plugin_settings (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key),
  FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS plugin_storage (
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key),
  FOREIGN KEY (plugin_id) REFERENCES plugins(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS plugin_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS change_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL,
  plex_account_id TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  undone INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_activity_created ON plugin_activity(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_batches_plugin ON change_batches(plugin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`,
  },
  {
    id: 2,
    sql: `
ALTER TABLE plex_servers ADD COLUMN account_username TEXT;
ALTER TABLE plex_servers ADD COLUMN connection_uris TEXT;
`,
  },
  {
    id: 3,
    sql: `
CREATE TABLE IF NOT EXISTS preroll_buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  folder_path TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preroll_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER,
  mtime_ms INTEGER,
  duration_ms INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  missing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (bucket_id) REFERENCES preroll_buckets(id) ON DELETE CASCADE,
  UNIQUE (bucket_id, relative_path)
);

CREATE TABLE IF NOT EXISTS preroll_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  start_time TEXT,
  end_time TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  selection_mode TEXT NOT NULL DEFAULT 'random',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preroll_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  bucket_id INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (schedule_id) REFERENCES preroll_schedules(id) ON DELETE CASCADE,
  FOREIGN KEY (bucket_id) REFERENCES preroll_buckets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS preroll_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  used_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (bucket_id) REFERENCES preroll_buckets(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES preroll_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS preroll_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schedule_id INTEGER,
  generated_at TEXT,
  plex_value TEXT,
  items_json TEXT,
  warning TEXT,
  active_schedule_id INTEGER,
  FOREIGN KEY (schedule_id) REFERENCES preroll_schedules(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_preroll_items_bucket ON preroll_items(bucket_id);
CREATE INDEX IF NOT EXISTS idx_preroll_steps_schedule ON preroll_steps(schedule_id, position);
CREATE INDEX IF NOT EXISTS idx_preroll_history_bucket ON preroll_history(bucket_id);
`,
  },
  {
    id: 4,
    sql: `
ALTER TABLE preroll_schedules ADD COLUMN repeat_yearly INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 5,
    sql: `
CREATE TABLE IF NOT EXISTS rec_letterboxd_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  finished_at TEXT,
  film_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rec_letterboxd_films (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  letterboxd_uri TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  year INTEGER,
  tmdb_id INTEGER,
  imdb_id TEXT,
  rating REAL,
  watched INTEGER NOT NULL DEFAULT 0,
  watchlist INTEGER NOT NULL DEFAULT 0,
  tags TEXT,
  review_excerpt TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rec_letterboxd_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  film_id INTEGER,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  rss_guid TEXT,
  happened_on TEXT,
  rating REAL,
  tags TEXT,
  review_excerpt TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (film_id) REFERENCES rec_letterboxd_films(id) ON DELETE CASCADE,
  UNIQUE (rss_guid)
);

CREATE TABLE IF NOT EXISTS rec_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  days TEXT NOT NULL DEFAULT '[]',
  time_local TEXT NOT NULL DEFAULT '18:00',
  film_count INTEGER NOT NULL DEFAULT 1,
  runtime_min INTEGER,
  runtime_max INTEGER,
  prefer_plex INTEGER NOT NULL DEFAULT 1,
  allow_streaming INTEGER NOT NULL DEFAULT 0,
  genres TEXT NOT NULL DEFAULT '',
  excluded_genres TEXT NOT NULL DEFAULT '',
  rating_min REAL,
  rating_max REAL,
  output_type TEXT NOT NULL DEFAULT 'collection',
  plex_section_id TEXT,
  plex_destination_id TEXT,
  plex_destination_title TEXT,
  replace_on_watch INTEGER NOT NULL DEFAULT 1,
  remove_watchlist INTEGER NOT NULL DEFAULT 0,
  preset TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rec_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  slot_date TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (schedule_id, slot_date),
  FOREIGN KEY (schedule_id) REFERENCES rec_schedules(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rec_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER NOT NULL,
  run_id INTEGER,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  year INTEGER,
  tmdb_id INTEGER,
  plex_rating_key TEXT,
  discover_rating_key TEXT,
  provider TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  watched_at TEXT,
  recommended_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (schedule_id) REFERENCES rec_schedules(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rec_tmdb_movies (
  tmdb_id INTEGER PRIMARY KEY,
  title TEXT,
  year INTEGER,
  runtime INTEGER,
  vote_average REAL,
  genres TEXT,
  directors TEXT,
  actors TEXT,
  similar_ids TEXT,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rec_streaming_cache (
  tmdb_id INTEGER NOT NULL,
  region TEXT NOT NULL,
  providers TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (tmdb_id, region)
);

CREATE INDEX IF NOT EXISTS idx_rec_films_tmdb ON rec_letterboxd_films(tmdb_id);
CREATE INDEX IF NOT EXISTS idx_rec_items_schedule ON rec_items(schedule_id, active);
CREATE INDEX IF NOT EXISTS idx_rec_activity_film ON rec_letterboxd_activity(film_id);
`,
  },
  {
    id: 6,
    sql: `
ALTER TABLE preroll_buckets ADD COLUMN scan_error TEXT;
`,
  },
];

export function openDatabase(dbPath) {
  fs.mkdirSync(dbPath.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applied = new Set(
    db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(m.id);
    });
    tx();
  }
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value));
}
