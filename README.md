# Plex Toolkit

Lightweight self-hosted plugin host for Plex Media Server.

Install one Docker container, connect it to your Plex server, then install utilities as plugins. The first official plugin is **Netflix Rewatch**.

## Quick start

```bash
cd plex-toolkit
cp .env.example .env
# Edit .env and set ADMIN_PASSWORD

docker compose up -d --build
```

Open [http://localhost:8787](http://localhost:8787) and sign in with `ADMIN_PASSWORD`.

### Connect Plex

1. Open **Plex** in the admin UI.
2. Click **Log in with Plex**.
3. Approve **Plex Toolkit** in the Plex authorization window.
4. Return and click **I've authorized — continue**.
5. If you have multiple servers, choose which one to use.

The access token is encrypted at rest under `./data`. Server URLs are discovered from your Plex account; you can override the URL only if discovery cannot reach the server.

### Persistent data

```text
data/
  config/      encryption key
  database/   SQLite
  plugins/    installed plugins
  logs/
```

Container recreations keep this volume.

### Optional Plex webhook

Set `PUBLIC_URL` to a URL your Plex server can reach, then add a webhook:

`http://your-host:8787/webhooks/plex`

Playback events also work over the Plex websocket without Plex Pass. Webhooks add scrobble events when available.

## Local development

```bash
cp .env.example .env
# Set ADMIN_PASSWORD and PLUGIN_LOCAL_ROOTS to the parent Thunderhat folder
npm install
npm start
```

Install the sibling Netflix Rewatch plugin from **Repository → Install from local path** using `../plex-toolkit-netflix-rewatch` (must be under `PLUGIN_LOCAL_ROOTS`).

Install the Plex Notifier plugin from `../plex-notifier/plugin` the same way.

```bash
npm test
```

## Environment

| Variable | Description |
| --- | --- |
| `ADMIN_PASSWORD` | Required. Admin UI password |
| `PORT` | Default `8787` |
| `DATA_DIR` | Default `./data` (`/data` in Docker) |
| `PLEX_CLIENT_ID` | Optional stable Plex app client id; otherwise generated in `data/config/client.id` |
| `PUBLIC_URL` | Base URL for webhook display |
| `CATALOGUE_URL` | URL to a `repository.json` catalogue |
| `PLUGIN_LOCAL_ROOTS` | Semicolon-separated allowlist for local plugin installs |
| `SECRET_KEY` | Optional 64-char hex key; otherwise generated in `data/config/secret.key` |

## Architecture

See [docs/plugin-api.md](docs/plugin-api.md) for the stable Plugin API.

Plugins are never hard-coded into the host. They are installed from GitHub or an allowlisted local path, validated via `plugin.json`, and activated through a permission-checked facade.
