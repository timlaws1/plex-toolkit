# Plex Toolkit Tool API (v1)

Bundled tools live under `tools/` in the image. The Tools page catalog lists them; Install copies one into `data/plugins` (disabled until enabled). On every boot the host refreshes code only for tools already installed from that catalog, and removes anything under `data/plugins` that is not in it. Only image catalog tools are ever loaded: there is no install from a URL, a GitHub repository, or an arbitrary local path.

The runtime is not a sandbox. Tools run in the toolkit's own Node.js process via `import()`. The permissions below gate the `ctx` API only; a tool module could still import `node:fs` or `node:child_process` directly. That is why loading is limited to code shipped in the image.

## Package layout

```text
my-tool/
  plugin.json
  plugin.js
  settings.html   # optional; shown in a sandboxed iframe only
```

## Manifest (`plugin.json`)

```json
{
  "id": "my-tool",
  "name": "My Tool",
  "version": "1.0.0",
  "apiVersion": 1,
  "author": "Author",
  "description": "What it does",
  "entry": "plugin.js",
  "permissions": [
    "plex.read",
    "plex.discover",
    "plex.watch_state",
    "plex.dvr",
    "plex.refresh",
    "plex.prefs",
    "events.subscribe",
    "storage",
    "scheduler",
    "changes",
    "mail.send",
    "tmdb",
    "net.fetch",
    "fs.read",
    "sql.preroll",
    "sql.recommendations",
    "plex.collections"
  ],
  "settingsSchema": [
    {
      "key": "enabled",
      "type": "boolean",
      "label": "Enabled",
      "default": true
    },
    {
      "key": "smtpPassword",
      "type": "secret",
      "label": "SMTP password"
    }
  ]
}
```

### Rules

- `apiVersion` must be `1`
- `id` must be kebab-case
- `entry` must be a relative path inside the tool directory
- Unknown permissions are rejected at install time
- Setting type `secret` is encrypted at rest; leave blank on save to keep the previous value

## Lifecycle

```js
export async function activate(ctx) {
  // subscribe to events, register panels, etc.
}

export async function deactivate(ctx) {
  // optional cleanup; host also disposes subscriptions
}

/** Optional interactive page at GET/POST /plugins/:id/app */
export async function handleRequest(ctx, req) {
  return { title: 'My Tool', body: '<h1>Hello</h1>' };
}
```

`handleRequest` may return `{ title, body }`, `{ redirect, message, flash }`, `{ file, contentType }` (authenticated Range streaming; the size is read from disk and the path must be under `MEDIA_ROOTS`), `{ status: 404, body }`, or throw.

## Context (`ctx`)

The host passes a facade only. Tools do not receive the Plex token, filesystem access, or the database handle.

### Logging

- `ctx.log.info(message)`
- `ctx.log.warn(message)`
- `ctx.log.error(message)`

### Settings

- `ctx.settings.get()` → object of saved settings (secrets decrypted)

### Plex (`plex.read` / `plex.watch_state` / `plex.discover` / `plex.dvr` / `plex.refresh`)

- `ctx.plex.getServer()`
- `ctx.plex.getLibraries()`
- `ctx.plex.refreshLibrary(sectionId)` — trigger a library section scan (`plex.refresh`)
- `ctx.plex.getLibraryItems(libraryId, { type, start, size })` — paged movies/shows with guids, cast, crew, genres, view counts
- `ctx.plex.getShows(libraryId)` — TV shows with guids and credits when present
- `ctx.plex.getEpisodes(showRatingKey)` — ordered by season, then episode
- `ctx.plex.getMetadata(ratingKey)` — includes `guids`, `roles`, `directors`, `writers`, `genres`
- `ctx.plex.getWatchState(ratingKey)`
- `ctx.plex.markWatched(ratingKey)` — Plex scrobble
- `ctx.plex.markUnwatched(ratingKey)` — Plex unscrobble (preserves history where Plex allows)
- `ctx.plex.getWatchlist()` — account watchlist via Discover (`plex.discover`)
- `ctx.plex.addToWatchlist(ratingKey)` — add a Discover item to the account watchlist (`plex.discover`)
- `ctx.plex.removeFromWatchlist(ratingKey)` — remove a Discover item from the account watchlist (`plex.discover`)
- `ctx.plex.listCollections(sectionId)` — movie collections in a library (`plex.collections`)
- `ctx.plex.createCollection({ sectionId, title, ratingKeys })` — regular collection; needs at least one library item (`plex.collections`)
- `ctx.plex.addCollectionItems(collectionKey, ratingKeys)` / `removeCollectionItem` / `getCollectionItems` (`plex.collections`)
- `ctx.plex.setItemSummary(ratingKey, summary)` (`plex.collections`)
- `ctx.plex.createPlaylist({ title, ratingKeys })` — video playlist (`plex.collections`)
- `ctx.plex.addPlaylistItems` / `removePlaylistItem` / `getPlaylistItems` (`plex.collections`)
- `ctx.plex.searchDiscover(query, { limit })` — title search (`plex.discover`)
- `ctx.plex.getDiscoverMetadata(ratingKeyOrPath)` — Discover metadata with cast (`plex.discover`). Accepts an alphanumeric rating key or a `/library/metadata/<key>` path; anything else throws before a request is made. Discover requests only go to `discover.provider.plex.tv` and `metadata.provider.plex.tv`
- `ctx.plex.getDvrs()` — configured DVRs (`plex.dvr`)
- `ctx.plex.getDvrChannels()` — DVR channel titles for regional preference (`plex.dvr`)
- `ctx.plex.getSubscriptions()` — media/DVR subscriptions (`plex.dvr`)
- `ctx.plex.getMediaProviders()` — media providers including EPG/DVR (`plex.dvr`)
- `ctx.plex.getDvrMediaProviderId()` — preferred EPG provider id for recordings (`plex.dvr`)
- `ctx.plex.getSubscriptionTemplates(guid)` — recording templates for a Plex guid (`plex.dvr`)
- `ctx.plex.createSubscription(options)` — schedule a recording / subscription (`plex.dvr`); supports nested `hints` / `prefs` / `params`
- `ctx.plex.createSubscriptionFromTemplate(parameters, { targetLibrarySectionID, prefs })` — create from a template query string (`plex.dvr`)
- `ctx.plex.getPreference(id)` — read a PMS preference (`plex.prefs`)
- `ctx.plex.setPreference(id, value)` — set a PMS preference (`plex.prefs`)
- `ctx.plex.isConfigured()` — whether a server URL and token are set

### Filesystem (`fs.read` / `fs.write`)

Scoped to `MEDIA_ROOTS` when that env var is set (semicolon-separated absolute paths). When unset, paths are unrestricted (local development) and the toolkit logs a warning at startup. Docker compose sets it to `/prerolls`.

A path is allowed only when both checks pass:

- Lexically, the resolved path is a root or sits under one.
- The real path, after following every symbolic link, is a root or sits under one. For a path that does not exist yet, the nearest existing parent is resolved instead.

A symbolic link as the last part of the path is refused, unless it is one of the roots itself. `ctx.fs.writeFile` writes a temporary file in the same folder and renames it over the destination, so it never writes through a link. A file returned from `handleRequest` as `{ file }` goes through the same check before it is streamed; a path outside the roots gets `403`.

- `ctx.fs.listVideos(dir)` — recursive video file listing; returns `{ entries, error }` where `entries` are `{ relativePath, filename, sizeBytes, mtimeMs, durationMs? }` and `error` is `null` or `{ code, message, path }` when the path is missing, not a directory, or unreadable
- `ctx.fs.stat(absPath)`
- `ctx.fs.exists(absPath)`
- `ctx.fs.createReadStream(absPath, opts)`
- `ctx.fs.readMp4DurationMs(absPath)`
- `ctx.fs.writeFile(absPath, data)` (`fs.write`)
- `ctx.fs.mkdir(absPath)` — recursive (`fs.write`)
- `ctx.fs.unlink(absPath)` (`fs.write`)

### SQL (`sql.preroll` / `sql.recommendations` / `sql.trailers`)

Prepared statements against the host SQLite database. Each SQL permission allowlists its own tables. `sql.preroll` covers `preroll_buckets`, `preroll_items`, `preroll_schedules`, `preroll_steps`, `preroll_history`, `preroll_state`. `sql.recommendations` covers the `rec_*` schedule, Letterboxd, and cache tables. `sql.trailers` covers `trailer_downloads`. A tool cannot read another tool's tables or the host's own tables (`plex_servers`, `sessions`, `plugin_settings`, and so on).

Every statement is tokenized and walked before SQLite prepares it:

- One statement per call. A second statement after a `;` is rejected, for `exec` as well as `prepare`.
- The statement must start with `SELECT`, `INSERT`, `REPLACE`, `UPDATE`, `DELETE`, `WITH`, `VALUES`, `CREATE TABLE`, `CREATE [UNIQUE] INDEX`, `DROP TABLE`, or `ALTER TABLE`. `ATTACH`, `DETACH`, `PRAGMA`, `VACUUM`, `REINDEX`, `ANALYZE`, and `load_extension` are rejected anywhere in the statement.
- Every table named in `FROM` (including comma joins and parenthesized joins), `JOIN`, `INTO`, `UPDATE`, `TABLE`, `REFERENCES`, `CREATE INDEX ... ON`, and subqueries must be on the tool's allowlist. Quoted names and `main.` prefixes are checked the same way; any other schema is rejected. Table-valued functions such as `pragma_table_info` count as tables, so they are rejected too.
- A CTE name is allowed only if no table, index, or view of that name exists.
- A statement must name at least one allowlisted table.

`prepare` returns a wrapped statement (`run`, `get`, `all`, `iterate`, `columns`, `pluck`, `expand`, `raw`, `safeIntegers`, `bind`). `exec` returns the scoped handle. `transaction(fn)` returns a wrapped transaction function with `deferred`, `immediate`, and `exclusive`. None of them expose the host database connection.

- `ctx.sql.prepare(sql)`
- `ctx.sql.exec(sql)`
- `ctx.sql.transaction(fn)`

### Events (`events.subscribe`)

- `ctx.events.on(name, handler)`
- `ctx.events.off(name, handler)`

Events:

- `playback.started`
- `playback.progress`
- `playback.finished`
- `episode.watched`
- `movie.watched`
- `library.updated`

Playback payloads include `source` (`websocket` or `webhook`), `accountId`, `ratingKey`, progress fields, and `wasWatchedAtStart` (whether `viewCount > 0` when the session began). Events for other Plex accounts are filtered out when a configured account id is known. Webhook events must carry the configured account id; a webhook event with no account id is never delivered.

### Storage (`storage`)

Key-value store scoped to the tool id:

- `ctx.storage.get(key)`
- `ctx.storage.set(key, value)`
- `ctx.storage.delete(key)`

### Scheduler (`scheduler`)

- `ctx.scheduler.every(ms, fn, label)` — minimum interval 60 seconds

### Fetch (`net.fetch`)

- `ctx.fetch(url, init)` — outbound request with a browser TLS fingerprint. Use this for sites that reject Node's built-in fetch.

### Mail (`mail.send`)

- `ctx.mail.send({ to, subject, text, html, from })` — sends through the host mail server on the **Mail** page; `to` and `from` fall back to the addresses saved there
- `ctx.mail.isConfigured()` — true when a mail host and from address are saved
- `ctx.mail.defaultTo()` — the default recipient from the Mail page

### TMDb (`tmdb`)

One TMDb API key is shared by every tool and saved on the **API keys** page. Do not add a TMDb key to a tool's own settings.

- `ctx.tmdb.apiKey()` — the saved TMDb v3 API key, or `''` when none is set
- `ctx.tmdb.isConfigured()` — true when a key is saved

### Change batches / undo (`changes`)

- `ctx.changes.recordBatch({ title, summary, dryRun, changes, meta })`
- `ctx.changes.list({ limit })`
- `ctx.changes.get(id)`
- `ctx.changes.markUndone(id)`

### Panels

Register UI on the tool settings page without injecting HTML into the host:

```js
ctx.panels.add({
  title: 'Recent rewinds',
  empty: 'No rewinds yet',
  items: [
    {
      id: '123',
      title: 'Slow Horses',
      subtitle: 'S02E04',
      meta: '3 episodes changed',
      actions: [{ id: 'undo', label: 'Undo', confirm: 'Undo this rewind?' }],
    },
  ],
  actions: {
    async undo({ body }) {
      // ...
      return { message: 'Undone' };
    },
  },
});
```

## Security notes (v1)

- Manifest validation and permission checks are enforced
- Official tools ship under `tools/`; installed copies in `data/plugins` are refreshed from the image on every boot
- Library refresh requires `plex.refresh` (not `plex.read`)
- Runtime is in-process today; `PluginRuntime` is an interface so a worker/process sandbox can replace it later
- Do not assume Node `vm` isolation
