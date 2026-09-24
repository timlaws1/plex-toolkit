# Plex Toolkit

Self-hosted tools for your Plex Media Server. Run one Docker container, connect your Plex account, then install the tools you want from the catalog.

## Included tools

These ship in the image. Open **Tools** in the UI and click **Install** for each one you want (left disabled until you enable it).

- **Netflix Rewatch** — Netflix-style Continue Watching when you rewatch episodes
- **Plex Notifier** — track watchlist and favourite people and get Freeview/Live TV alerts
- **Letterboxd Watchlist Sync** — copy a public Letterboxd watchlist into your Plex watchlist
- **Preroll Scheduler** — simple cinema idents/trailers from media buckets and date-range schedules
- **Scheduled Recommendations** — taste-based film picks from Letterboxd, published into Plex on a schedule

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

Settings, the Plex token, and the database live in `./data`. An update replaces the app. On every start the new image refreshes code only for tools you have already installed, and keeps each tool's saved settings and enabled flag.

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

### Update from the app

Home shows the running version. When a newer build is on `main`, **Update** pulls that image and restarts the container.

That needs the Docker socket. Add this to the compose service, set `DOCKER_GID` to the group that owns `/var/run/docker.sock`, then recreate the container once:

```yaml
group_add:
  - "${DOCKER_GID}"
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

The socket lets this app control Docker on the host. Leave it out if you would rather update with the commands above.

## Connect Plex

1. Open **Plex** in the admin UI.
2. Click **Log in with Plex**.
3. Approve **Plex Toolkit** in the Plex authorization window.
4. Return and click **I've authorized — continue**.
5. If you have multiple servers, choose which one to use.

Your Plex access token is encrypted at rest under `./data`.

## Preroll Scheduler

Install **Preroll Scheduler** from **Tools**, then enable it and open the app.

1. Mount your preroll folders into the container and set `MEDIA_ROOTS` (see below).
2. In the tool app: **Buckets** → point each bucket at a folder Toolkit can read.
3. **Schedules** → ordered steps (for example: 1× Cinema Idents, 1× Trailers).
4. Leave one schedule with no dates as the default; add Halloween/Christmas date ranges as needed.

The tool writes selected paths to Plex’s `CinemaTrailersPrerollID` preference (comma-separated, played in order). Paths must be readable by the **Plex Media Server** process. If Toolkit and Plex use different mount paths for the same files, set Toolkit/Plex prefixes under the tool’s **Settings**.

Cinema Trailers must be enabled on the Plex client and on the movie library.

Example compose additions:

```yaml
environment:
  MEDIA_ROOTS: /prerolls
volumes:
  - ./prerolls:/prerolls
```

Then use `/prerolls/idents` (etc.) as bucket folder paths. If Plex sees those files as `D:\Plex\prerolls\idents\…`, set Toolkit prefix `/prerolls` and Plex prefix `D:\Plex\prerolls` in tool Settings. When `MEDIA_ROOTS` is unset (local `npm run dev`), bucket paths are unrestricted.

**Troubleshooting:** Bucket folder paths must be the **container-side** path (for example `/prerolls/idents`), not the host path (for example `/mnt/Thunderhat/PreRoll`). If a bind mount is owned by a different UID than the container’s `node` user, scans fail with a permission error — that message appears on the **Buckets** screen and in `docker logs` (and at startup when `MEDIA_ROOTS` is set).

Quick start without compose:

```bash
docker run -d --name plex-toolkit -p 8787:8787 \
  -e ADMIN_PASSWORD=changeme \
  -e DATA_DIR=/data \
  -v ./data:/data \
  -v /path/to/your/prerolls:/prerolls \
  -e MEDIA_ROOTS=/prerolls \
  ghcr.io/timlaws1/plex-toolkit:latest
```

Set a strong `ADMIN_PASSWORD`. Optional: `-e PUBLIC_URL=…`, `-e PLEX_CLIENT_ID=…`.

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
- Tools run in-process with declared permissions. Only tools from the image catalog can be installed; startup removes anything else under `./data/plugins`.

## Persistent data

```text
data/
  config/     encryption key
  database/   SQLite
  plugins/    installed tools (code refreshed from the image on boot for catalog tools)
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
| `MEDIA_ROOTS` | Optional semicolon-separated roots for `fs.read` tools (e.g. Preroll). Unset = unrestricted |

## Tool API

See [docs/plugin-api.md](docs/plugin-api.md) for the host API used by bundled tools.
