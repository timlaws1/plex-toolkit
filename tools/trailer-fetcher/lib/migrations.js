const SCHEMA = `
CREATE TABLE IF NOT EXISTS trailer_downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT UNIQUE NOT NULL,
  raw_title TEXT NOT NULL,
  film_title TEXT NOT NULL,
  traileraddict_url TEXT NOT NULL,
  video_url TEXT,
  tmdb_id INTEGER,
  genres TEXT,
  certificate TEXT,
  release_date TEXT,
  file_path TEXT,
  downloaded_at TEXT,
  removed_at TEXT
);
`;

export function runMigrations(sql) {
  sql.exec(SCHEMA);
}
