# Plex Toolkit

Self-hosted tools for your Plex Media Server. Run one Docker container, connect your Plex account, and use the included tools.

## Included tools

- **Netflix Rewatch** — Netflix-style Continue Watching when you rewatch episodes
- **Plex Notifier** — track watchlist and favourite people and get Freeview/Live TV alerts
- **Letterboxd Watchlist Sync** — copy a public Letterboxd watchlist into your Plex watchlist

## Quick start

```bash
git clone https://github.com/timlaws1/plex-toolkit.git
cd plex-toolkit
cp .env.example .env
# Set a strong ADMIN_PASSWORD in .env
docker compose up -d --build
```

Open [http://localhost:8787](http://localhost:8787) and sign in with `ADMIN_PASSWORD`.

### Connect Plex

1. Open **Plex** in the admin UI.
2. Click **Log in with Plex**.
3. Approve **Plex Toolkit** in the Plex authorization window.
4. Return and click **I've authorized — continue**.
5. If you have multiple servers, choose which one to use.

Your Plex access token is encrypted at rest under `./data`.

### Updating

```bash
docker compose pull
docker compose up -d
```

Or rebuild from source:

```bash
docker compose up -d --build
```

On every start the host recopies bundled tools from the image into `./data` and keeps your settings.

## Security

- Set a strong unique `ADMIN_PASSWORD`. Do not leave the example value.
- Keep port `8787` on your LAN (or behind a reverse proxy with TLS). Do not publish it to the open internet without protection.
- Treat `./data` as sensitive: encryption key, encrypted Plex token, SQLite, and tool settings.
- `POST /webhooks/plex` is unauthenticated by design so Plex can call it. Only enable a public webhook URL if you understand that risk.
- Tools run in-process with declared permissions. Only the tools shipped in the image are loaded.

## Persistent data

```text
data/
  config/     encryption key
  database/   SQLite
  plugins/    runtime copies of bundled tools (overwritten from the image on boot)
  logs/
```

## Optional Plex webhook

Set `PUBLIC_URL` to a URL your Plex server can reach, then add a webhook:

`http://your-host:8787/webhooks/plex`

Playback events also work over the Plex websocket without Plex Pass. Webhooks add scrobble events when available.

## Local development

```bash
cp .env.example .env
# Set ADMIN_PASSWORD
npm install
npm start
```

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
| `SECRET_KEY` | Optional 64-char hex key; otherwise generated in `data/config/secret.key` |

## Tool API

See [docs/plugin-api.md](docs/plugin-api.md) for the host API used by bundled tools.
