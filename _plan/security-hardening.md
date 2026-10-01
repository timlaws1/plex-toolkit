# Security hardening plan

Plan for the review of Plex Toolkit on `main` (`687b41e`). The app already encrypts the Plex token, refuses to boot without `ADMIN_PASSWORD`, refreshes installed tools from the image catalog, and keeps `SameSite=Lax` session cookies. This plan closes the gaps that let an unauthenticated caller drive Plex changes, and replaces the string checks that currently stand in for SQL and filesystem isolation.

Work in the order below. Each step should land with tests before the next one starts. Do not put calendar estimates on this work; the sequence is by dependency and impact.

## 1. Authenticate the Plex webhook and stop treating it as the owner

### Problem

`POST /webhooks/plex` in `src/http/app.js` accepts JSON and URL-encoded bodies with no credential. `PlexEventMonitor.handleWebhook` publishes those bodies onto the event bus. Playback tools then act:

- Netflix Rewatch uses `viewOffset` from the request. `wasWatchedAtStart` comes from Plex, so a caller who can guess a watched episode rating key can mark later episodes unwatched.
- Scheduled Recommendations treats `media.scrobble` as a real watch and can remove or replace a published pick.
- Preroll Scheduler regenerates `CinemaTrailersPrerollID` on `media.play` for a movie. Attacker-supplied `contentRating` survives, because fetched metadata does not include that field.

The account filter in `src/plugins/api.js` does not stop this. `SessionTracker` stores a missing account id as `"0"`, and the filter allows `"0"`. A body with no account id is delivered to every subscriber.

Plex’s real webhook is `multipart/form-data` with a `payload` field. The app has no multipart parser, so a genuine Plex call can be a no-op while a JSON call still runs.

`"0"` may be how Plex labels the server owner on the notification websocket. Do not delete that exception for websocket events until a fixture proves the owner id. Webhook events are a separate path and must not inherit it.

### Change

1. Create a webhook secret on first boot, the same way `secret.key` and `client.id` are created (`src/plex/auth.js`, `src/crypto/secrets.js`). Store it in `data/config/webhook.token` with mode `0600`. Allow `WEBHOOK_TOKEN` in the environment to override it, and document that in `.env.example`.
2. Mount the route at `POST /webhooks/plex/:token`. Compare the path token to the stored secret with `crypto.timingSafeEqual` on equal-length buffers. Respond `404` for a missing or wrong token so the body is never parsed as an event.
3. Parse `multipart/form-data` on that route only, read the `payload` field, and keep the existing JSON-string fallback. Reject a body that is not a Plex notification object.
4. Tag webhook-sourced events (`source: 'webhook'`). In the subscriber wrapper:
   - When a configured account id exists and the event came from the webhook, require `accountId` to equal that id.
   - Drop webhook events with a missing account id. Do not default them to `"0"`.
   - Leave the websocket path unchanged until owner-id fixtures exist. Record the fixture result in the test name so the `"0"` exception is either kept on purpose or removed.
5. Show the tokenized URL on the Plex page (the copy field already built in `src/http/app.js`). Tell the operator to replace the old URL in Plex. Update the Security section of `README.md`: the webhook is unauthenticated only in the sense that it does not use the admin session; it requires the path token.
6. Cap webhook body size below the global `15mb` limit and ignore repeated events for the same session key inside a short window, so a leaked token cannot fan out metadata lookups without bound.

### Tests

- Wrong or missing token: no bus event, no Plex metadata fetch.
- Valid token plus `media.play` / `media.scrobble`: the existing monitor behavior runs.
- Multipart body with a `payload` JSON field is accepted when the token matches.
- Webhook event with no account id, or with a different account id, does not reach Netflix Rewatch, preroll, or recommendations.
- A websocket-style event is unchanged relative to the fixture decision above.

### Done when

An internet or LAN client cannot change watch state, collections, or the preroll preference without the path token, and a real Plex webhook with that token still reaches the tools.

## 2. Enforce SQL scope in the database, not with a regex

### Problem

`src/plugins/sql-scope.js` allowlists tables by scanning SQL text. These statements pass and then run on the host connection:

- `SELECT token_encrypted FROM preroll_state, plex_servers` (only the first name after `FROM` is seen)
- `SELECT 1 FROM preroll_state; ATTACH DATABASE ...` (a later statement is allowed once one allowlisted table appears)
- `PRAGMA ...` (no leading `SELECT`/`INSERT`/`UPDATE`/`DELETE`/`WITH`, and no table name)

Bundled tools currently use fixed strings and `?` placeholders, including Trailer Fetcher’s `IN (${placeholders})` list. The regex is still the boundary described in `docs/plugin-api.md`. `createScopedSql().transaction()` returns the host transaction with no extra check.

### Change

1. Replace `extractSqlTableNames` as the security check. Use SQLite’s authorizer (`better-sqlite3` `db.authorizer`) on a dedicated connection, or a statement walker that sees every table in `FROM`, comma joins, CTEs, and subqueries.
2. Allow one statement per `prepare` / `exec`. Reject `ATTACH`, `DETACH`, `PRAGMA`, `VACUUM`, `REINDEX`, and `load_extension`.
3. Keep the current allowlists (`sql.preroll`, `sql.trailers`, `sql.recommendations`). A tool may only touch tables for permissions it declared. Preroll Scheduler’s read of `trailer_downloads` stays valid because its manifest includes `sql.trailers`.
4. Make `transaction(fn)` wrap the same scoped `prepare` the tool already holds, so a callback cannot reach the unscoped database.
5. Update `docs/plugin-api.md` so it describes the authorizer (or walker) instead of a best-effort scan.

### Tests

Add the three bypasses above next to the existing cases in `test/preroll.test.js` and `test/recommendations.test.js`. A preroll-scoped handle must still prepare the bucket scan upsert (`ON CONFLICT ... DO UPDATE SET`). A recommendations-scoped handle must still be rejected for `preroll_state` and `plex_servers`.

### Done when

A tool connection cannot read `plex_servers`, `sessions`, or `plugin_settings`, and cannot attach another database, even if it builds the statement itself.

## 3. Resolve media paths and check streamed files

### Problem

`assertPathAllowed` in `src/plugins/fs-scope.js` uses `path.resolve` and a `..` check. Symlinks inside `MEDIA_ROOTS` still point outside the root, and `stat`, `createReadStream`, `writeFile`, and `unlink` follow them. `scanBucketFolder` skips symlink dirents; the other methods do not.

`streamPluginFile` in `src/http/app.js` streams `result.file` with no root check. Preroll previews call `ctx.fs.stat` first, which does check. The host does not, so the next tool that returns a path skips the allowlist.

`MEDIA_ROOTS` unset means unrestricted access (`parseMediaRoots` returns null). Compose defaults it to `/prerolls`. `npm start` does not.

Trailer Fetcher writes RSS-derived filenames with `fs.writeFile`. A symlink planted at that path is overwritten at its target.

### Change

1. After the string check, `realpath` the file or the nearest existing parent. Allow the path only when that real path is the root or a descendant of a root. Apply this inside `assertPathAllowed` so every `ctx.fs` method inherits it.
2. On create, refuse to follow a final symlink (`O_NOFOLLOW`, or write a temp file in the resolved directory and rename it over the destination).
3. Run the same helper in `streamPluginFile` before `createReadStream`. Reject a path the plugin did not prove, including range requests.
4. At startup, when `mediaRoots` is null, log a warning that filesystem tools are unrestricted. Keep that mode for local development. Docker compose stays on `/prerolls`.
5. Reject preroll filenames that contain a comma before they are joined into `CinemaTrailersPrerollID` (`buildPlexPrerollValue` in `tools/preroll-scheduler/lib/paths.js`). Plex splits that preference on commas.

### Tests

Extend `test/preroll.test.js`:

- A symlink inside the allowed root that points at a file outside it is denied for read, write, and stat.
- `streamPluginFile` refuses a path outside the roots and still streams an allowed preview.
- A comma in a filename is omitted or escaped in the Plex preference value.

### Done when

A name that lexically sits under `MEDIA_ROOTS` cannot read or overwrite a file whose real path is outside those roots, and preview streaming uses that same rule.

## 4. Keep the Discover client on the Discover hosts

### Problem

`PlexClient.getDiscoverMetadata` treats any string that starts with `/` as a path. `new URL('//attacker.example/...', 'https://discover.provider.plex.tv/')` is scheme-relative, so the request leaves Discover and still receives `X-Plex-Token`. No bundled tool calls this method today. It is on the plugin API (`plex.discover`).

Several other Plex paths interpolate ids without `encodeURIComponent` (`/library/sections/${libraryId}/all`, collection and playlist ids). Those ids come from Plex or from saved settings. Encode them in the same change so a saved value cannot reshape the path.

### Change

1. Accept only a numeric rating key, or one path under `/library/metadata/` with no scheme, no leading `//`, no backslashes, and no `?` or `#`.
2. Build the request with `new URL` against the fixed Discover bases and verify `url.host` is still `discover.provider.plex.tv` or `metadata.provider.plex.tv` before `fetch`.
3. Encode dynamic path segments in `src/plex/client.js`.

### Tests

A rating key and `/library/metadata/123` still resolve. `//evil`, `https://evil`, and `/\\evil` throw before any request. A library id containing `../` cannot change the path host.

### Done when

A plugin with `plex.discover` cannot move the Plex token onto another host through this method.

## 5. Remove unused remote plugin installation

### Problem

Tools run in-process via `import()` (`src/plugins/runtime.js`). The permission object is a facade; a module can import `node:fs` or `node:child_process`. The real control is `PluginManager.syncBundled`, which recopies catalog tools and deletes anything else on boot.

`installFromGithub`, `installFromLocal`, and `update` in `src/plugins/manager.js` are not mounted on any route. They still download a tarball, extract it, and activate it in this process. A catalog id collision would run until the next restart.

### Change

1. Delete `installFromGithub`, `installFromLocal`, `update`, and the tar extractor if nothing else calls them.
2. Keep `installBundled` and `syncBundled`.
3. Say in `docs/plugin-api.md` that the in-process runtime is not a sandbox and that only image catalog tools are loaded.

### Tests

Update `test/bundled-sync.test.js` so a directory under `data/plugins` that is not in the catalog is removed, and a catalog id is overwritten from `tools/`.

### Done when

The production process has no function that loads plugin code from a URL or from an arbitrary local path.

## 6. Harden the admin session

### Problem

`POST /login` compares `ADMIN_PASSWORD` with `!==`. There is no failure delay, lockout, or log line. `hashPassword` / `verifyPassword` in `src/crypto/secrets.js` are unused. The session cookie is `HttpOnly` and `SameSite=Lax`, lasts 7 days, and is never `Secure`. `pendingPlexToken` is stored in the `sessions` table as plaintext JSON until a server is chosen. The durable token in `plex_servers` is already AES-256-GCM.

### Change

1. Compare the admin password with `crypto.timingSafeEqual` on SHA-256 digests (or the existing scrypt helper). Keep the source of truth as `ADMIN_PASSWORD`; hashing at rest is a separate migration and is not required for this step.
2. On failure, wait a short fixed delay, write one log line without the password, and share that response for an unknown and a wrong password.
3. After a small number of failures from the same client, reject further attempts for a cool-down window. Store the counter in the database so it survives a restart.
4. Set `Secure` on `pt_session` when `PUBLIC_URL` is `https:`, or when the request is HTTPS. Leave it unset for plain HTTP on a LAN.
5. Encrypt `pendingPlexToken` with `secrets.encrypt` before it enters `sessions.data`, and decrypt it only in the select-server handler. Clear it as soon as the server is saved.

### Tests

A wrong password does not create a session. Two equal-length passwords that differ by one character both fail. The pending token in `sessions` is not the raw Plex token. An HTTPS `PUBLIC_URL` produces a `Secure` cookie.

### Done when

Guessing the admin password is slowed and logged, the session cookie is `Secure` on HTTPS, and the database does not hold a usable Plex token in session JSON.

## 7. Follow-ups that do not block the items above

These are real, and they are smaller than the six items above.

| Item | Change |
| --- | --- |
| Trailer page fetch | In `tools/trailer-fetcher/lib/traileraddict.js`, fetch item links only for `https://traileraddict.com` (and `www`). Keep the existing MP4 host check for `video.traileraddict.com`. |
| SMTP headers | In `src/mail/smtp.js`, reject `from` and `to` values that contain CR or LF before `MAIL FROM`, `RCPT TO`, and the header block. Subjects with non-ASCII bytes are already base64-encoded. |
| Preference writes | In the preroll tool, call `setPreference` only for `CinemaTrailersPrerollID`. A later API allowlist can restrict `plex.prefs` the same way. |
| Page headers | Send `Content-Security-Policy: frame-ancestors 'none'` and `X-Content-Type-Options: nosniff` from `createApp`. Plugin `settings.html` already has its own CSP and an empty iframe sandbox. |
| Update pull | Keep one-click update opt-in via `DOCKER_GID`. When recording the image to pull, store the digest from `inspect` and pull that digest rather than a floating tag. |
| Image build | Multi-stage the Dockerfile so `python3`, `make`, and `g++` are not in the runtime image. Use `npm ci` in `.github/workflows/docker-publish.yml`. |

## Out of scope

- Replacing the in-process runtime with a worker sandbox. Section 5 removes the unused remote installer; a sandbox is a separate design.
- Removing the Docker socket mount. The README already tells operators to delete it when they update by hand.
- Rotating `SECRET_KEY`. Changing it makes the stored Plex token unreadable; that behavior stays.

## Documentation to touch in the same changes

- `README.md` Security and the webhook paragraph under Connect Plex
- `.env.example` for `WEBHOOK_TOKEN`
- `docs/plugin-api.md` for SQL enforcement, realpath rules, and the in-process limit

## Exit check

The work is complete when `npm test` covers the new webhook, SQL, path, and Discover cases, a forged webhook no longer reaches the three playback tools, and the Plex page shows a tokenized webhook URL that a multipart Plex callback can still call.
