# Plex Toolkit

Self-hosted tools for your Plex Media Server. Run one Docker container, connect your Plex account, and use the included tools.

## Included tools

- **Netflix Rewatch** — Netflix-style Continue Watching when you rewatch episodes
- **Plex Notifier** — track watchlist and favourite people and get Freeview/Live TV alerts
- **Letterboxd Watchlist Sync** — copy a public Letterboxd watchlist into your Plex watchlist

## Install

Use the published image.

```bash
mkdir plex-toolkit && cd plex-toolkit
```

Create `.env`:

```bash
ADMIN_PASSWORD=choose-a-long-unique-password
# Optional. Shown in the UI for the Plex webhook URL.
# PUBLIC_URL=http://192.168.1.20:8787
```

Create `docker-compose.yml`:

```yaml
services:
  plex-toolkit:
    image: ghcr.io/timlaws1/plex-toolkit:latest
    container_name: plex-toolkit
    ports:
      - "8787:8787"
    environment:
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:?Set ADMIN_PASSWORD in .env}
      TZ: Europe/London
      DATA_DIR: /data
      PUBLIC_URL: ${PUBLIC_URL:-http://localhost:8787}
    volumes:
      - ./data:/data
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
```

Start it:

```bash
docker compose up -d
```

The same thing as a single command:

```bash
docker run -d \
  --name plex-toolkit \
  -p 8787:8787 \
  -e ADMIN_PASSWORD=choose-a-long-unique-password \
  -e TZ=Europe/London \
  -e DATA_DIR=/data \
  -e PUBLIC_URL=http://localhost:8787 \
  -v /path/to/plex-toolkit/data:/data \
  --add-host host.docker.internal:host-gateway \
  --restart unless-stopped \
  ghcr.io/timlaws1/plex-toolkit:latest
```

Open [http://localhost:8787](http://localhost:8787) and sign in with `ADMIN_PASSWORD`.

If `docker compose pull` or `docker run` asks you to log in, the GitHub package is still private. Either make `plex-toolkit` public under your GitHub Packages settings, or log in once:

```bash
docker login ghcr.io -u YOUR_GITHUB_USERNAME
```

Use a GitHub personal access token with `read:packages` as the password.

## Update

Settings, the Plex token, and the database live in `./data`. An update replaces the app and the bundled tools, and leaves that folder alone.

```bash
docker compose pull
docker compose up -d
```

With `docker run`, pull the new image and recreate the container with the same `-v` data path and `-e` values:

```bash
docker pull ghcr.io/timlaws1/plex-toolkit:latest
docker stop plex-toolkit
docker rm plex-toolkit
# then the same docker run command as install
```

On every start the new image recopies its tools into `./data/plugins` and keeps each tool's saved settings.

## Connect Plex

1. Open **Plex** in the admin UI.
2. Click **Log in with Plex**.
3. Approve **Plex Toolkit** in the Plex authorization window.
4. Return and click **I've authorized — continue**.
5. If you have multiple servers, choose which one to use.

Your Plex access token is encrypted at rest under `./data`.

## Install from source

```bash
git clone https://github.com/timlaws1/plex-toolkit.git
cd plex-toolkit
cp .env.example .env
# Set a strong ADMIN_PASSWORD in .env
docker compose up -d --build
```

## Update from source

```bash
git pull
docker compose up -d --build
```

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
