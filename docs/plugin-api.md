# Plex Toolkit Tool API (v1)

Bundled tools live under `tools/` in the image and are copied into `data/plugins` on every boot.

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
    "events.subscribe",
    "storage",
    "scheduler",
    "changes",
    "mail.send"
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

`handleRequest` may return `{ title, body }`, `{ redirect, message, flash }`, or throw.

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
- `ctx.plex.searchDiscover(query, { limit })` — title search (`plex.discover`)
- `ctx.plex.getDiscoverMetadata(ratingKeyOrPath)` — Discover metadata with cast (`plex.discover`)
- `ctx.plex.getDvrs()` — configured DVRs (`plex.dvr`)
- `ctx.plex.getDvrChannels()` — DVR channel titles for regional preference (`plex.dvr`)
- `ctx.plex.getSubscriptions()` — media/DVR subscriptions (`plex.dvr`)
- `ctx.plex.createSubscription(options)` — schedule a recording / subscription (`plex.dvr`); supports nested `hints` / `prefs` / `params`

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

Playback payloads include `accountId`, `ratingKey`, progress fields, and `wasWatchedAtStart` (whether `viewCount > 0` when the session began). Events for other Plex accounts are filtered out when a configured account id is known.

### Storage (`storage`)

Key-value store scoped to the tool id:

- `ctx.storage.get(key)`
- `ctx.storage.set(key, value)`
- `ctx.storage.delete(key)`

### Scheduler (`scheduler`)

- `ctx.scheduler.every(ms, fn, label)` — minimum interval 60 seconds

### Mail (`mail.send`)

- `ctx.mail.send({ to, subject, text, html, from })` — uses the tool's SMTP settings (`smtpHost`, `smtpPort`, `smtpUser`, `smtpPassword`, `smtpFrom`, `smtpTo`, optional `smtpSecure`)

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
- Official tools ship under `tools/` and are recopied into `data/plugins` on every boot
- Library refresh requires `plex.refresh` (not `plex.read`)
- Runtime is in-process today; `PluginRuntime` is an interface so a worker/process sandbox can replace it later
- Do not assume Node `vm` isolation
