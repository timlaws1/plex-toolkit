# Plex Toolkit

Self-hosted tools for your Plex Media Server. Run one Docker container, sign in with your Plex account, then install the tools you want.

## Tools

These ship in the image. Open **Tools** and click **Install** on the ones you want, then **Enable** them.

- **Netflix Rewatch** — Netflix-style Continue Watching when you rewatch episodes
- **Plex Notifier** — rank your most-watched actors and directors, track favourites, and get emailed when they or watchlist titles air on Freeview
- **Letterboxd Watchlist Sync** — copy a public Letterboxd watchlist into your Plex watchlist
- **Preroll Scheduler** — cinema idents and trailers before films, from media buckets and date-range schedules
- **Scheduled Recommendations** — film picks based on your Letterboxd ratings, added to a Plex collection or playlist, or emailed to you

Click the pin next to an installed tool to add it to the sidebar under **Tools**.

## Install

You need a machine that runs Docker with Docker Compose: a Linux server, a NAS, or Docker Desktop on Windows or Mac. You only edit one file, `.env`. Leave `docker-compose.yml` as it is.

**1. Make a folder and download the two files**

```bash
mkdir plex-toolkit
cd plex-toolkit
curl -o docker-compose.yml https://raw.githubusercontent.com/timlaws1/plex-toolkit/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/timlaws1/plex-toolkit/main/.env.example
```

On Windows PowerShell, type `curl.exe` instead of `curl`. You can also download [`docker-compose.yml`](docker-compose.yml) and [`.env.example`](.env.example) from this page and rename the second one to `.env`.

**2. Fill in `.env`**

Open `.env` in a text editor and set:

| Setting | What to put |
| --- | --- |
| `ADMIN_PASSWORD` | Required. A long, unique password for the toolkit's web page |
| `PORT` | The port to open it on. `8787` unless something else already uses it |
| `TZ` | Your time zone, for example `Europe/London` or `America/New_York`. Recommendation schedules run at this local time |
| `PREROLL_DIR` | Only for Preroll Scheduler: the folder on this machine with your preroll videos. The default `./prerolls` is created next to `docker-compose.yml` |
| `DOCKER_GID` | Optional, for one-click updates. Run `stat -c '%g' /var/run/docker.sock` and paste the number. On Docker Desktop, use `0`. Leave blank to update by hand |
| `PUBLIC_URL` | Optional. Only needed if Plex can't reach the address you open the toolkit with, for example `http://192.168.1.20:8787` |

**3. Start it**

```bash
docker compose up -d
```

**4. Sign in**

Open `http://your-server:8787` (use your `PORT` if you changed it) and sign in with `ADMIN_PASSWORD`. Then [connect Plex](#connect-plex) and install the tools you want from **Tools**.

**Changing a setting later:** edit `.env`, then run `docker compose up -d` again. Your data is kept.

## Updating

**Home** shows the running version. When a newer build is available, click **Update** and the toolkit pulls the new image and restarts itself. This needs `DOCKER_GID` set in `.env`.

Without it, update from the folder with `docker-compose.yml`:

```bash
docker compose pull
docker compose up -d
```

Your settings, Plex token, and database live in `./data` and are kept. Installed tools keep their settings and enabled state.

## Connect Plex

1. Open **Plex** and click **Log in with Plex**.
2. Approve **Plex Toolkit** in the Plex window.
3. Return and click **I've authorized — continue**.
4. If you have more than one server, choose which one to use.

Your Plex token is encrypted at rest under `./data`.

Once connected, the **Plex** screen shows your webhook URL with a copy button. Adding it in Plex (Settings → Webhooks) is optional: tools already get playback events over the Plex websocket, and webhooks add scrobble events when you have Plex Pass. If the URL shows `localhost`, set `PUBLIC_URL` to an address your Plex server can reach.

## Mail

Tools that send email (Plex Notifier digests, emailed recommendations) share one outgoing mail server. Set it up on the **Mail** page: SMTP host, port, username, password, from address, and a default recipient. **Send test email** checks it works.

Each tool can override the recipient in its own settings. If you set up SMTP inside Plex Notifier before this page existed, those settings are copied over automatically on first start.

## Scheduled Recommendations

1. In the tool's settings, add a TMDb API key (free from themoviedb.org), your Letterboxd username, and tick the streaming services you subscribe to.
2. Open the tool and import your Letterboxd export ZIP (Letterboxd Settings → Import & Export). The RSS feed keeps your taste up to date after that.
3. Create a schedule, or start from a preset (Tonight, Film Night, One Film Every Night, Weekend Films).

Each schedule sets:

- **When** — days of the week and a time
- **What to pick** — number of films, age rating cap (U, PG, 12, 15), runtime, genres to include or exclude, and TMDb score range
- **Where it goes** — Plex collection, Plex playlist, or email

Turn on **Include streaming titles** to also suggest films on your selected services. Those films are not in your Plex library, so a schedule that includes them is always emailed. Leave it off to keep a schedule to your Plex library.

With an age cap set, films without a known UK certificate are skipped. Certificates come from Plex first, then TMDb.

Click **Test** on a schedule to see what it would pick right now, without publishing, emailing, or counting it as a run. **Run now** does it for real.

## Preroll Scheduler

1. Put your preroll videos in the host folder set by `PREROLL_DIR`. It is mounted at `/prerolls` in the container.
2. In the tool: **Buckets** → point each bucket at a container path such as `/prerolls/idents`.
3. **Schedules** → add ordered steps, for example 1× Cinema Idents, then 1× Trailers. Join a step with **Or** to make it an alternative to the step above: `1× Idents and (1× Adverts or 1× Trailers)` always plays an ident, then either an advert or a trailer.
4. Leave one schedule with no dates as the default, and add date ranges for Halloween, Christmas, and so on.

The tool writes the chosen files to Plex's `CinemaTrailersPrerollID` preference. Cinema Trailers must be enabled on the Plex client and on the movie library.

Paths must be readable by **Plex Media Server** too. If Plex sees the same files at a different path (for example `D:\Plex\prerolls`), set the Toolkit prefix `/prerolls` and the Plex prefix `D:\Plex\prerolls` in the tool's settings.

If a bucket shows a permission error, the folder is owned by a different user than the container's `node` user. The error is shown on the **Buckets** screen and in `docker logs`.

## Security

- Use a strong, unique `ADMIN_PASSWORD`.
- Keep the port on your LAN, or behind a reverse proxy with TLS. Do not expose it to the internet unprotected.
- Treat `./data` as sensitive: it holds the encryption key, encrypted Plex token, database, and tool settings.
- The Docker socket mount lets the toolkit control Docker on the host when `DOCKER_GID` is set. If you would rather it had no access at all, delete the `docker.sock` line and the `group_add` block from `docker-compose.yml` and update by hand.
- `POST /webhooks/plex` has no login, so Plex can call it.
- Only tools from the image can be installed. Anything else under `./data/plugins` is removed on start.

## Environment

All of these go in `.env`.

| Variable | Description |
| --- | --- |
| `ADMIN_PASSWORD` | Required. Admin password |
| `PORT` | Port to listen on. Default `8787` |
| `TZ` | Time zone for schedules. Default `Europe/London` |
| `PREROLL_DIR` | Host folder mounted at `/prerolls` for Preroll Scheduler. Default `./prerolls` |
| `DOCKER_GID` | Group that owns `/var/run/docker.sock`, for in-app updates |
| `PUBLIC_URL` | Address Plex can reach the toolkit on, used for the webhook URL. Default: the address you open the toolkit with |
| `MEDIA_ROOTS` | Container folders file-reading tools may use, separated by `;`. Default `/prerolls` |
| `PLEX_CLIENT_ID` | Optional fixed Plex app id. Otherwise generated in `data/config/client.id` |
| `SECRET_KEY` | Optional 64-character hex key. Otherwise generated in `data/config/secret.key`. Set it before the first start only: changing it later makes the saved Plex token unreadable |
| `DATA_DIR` | Data folder when running without Docker. Default `./data` (Docker always uses `/data`) |

## Development

```bash
cp .env.example .env   # set ADMIN_PASSWORD
npm install
npm start
npm test
npm run css            # rebuild styles after editing src/http/public/input.css
```

To try a local Docker build with the normal `docker-compose.yml`, tag it with the published name:

```bash
docker build -t ghcr.io/timlaws1/plex-toolkit:latest .
docker compose up -d
```

See [docs/plugin-api.md](docs/plugin-api.md) for the host API tools use.
