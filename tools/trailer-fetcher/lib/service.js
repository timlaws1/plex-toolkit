import path from 'node:path';
import { cleanFilmTitle } from './traileraddict.js';
import { createTmdbClient, getTmdbConfig } from './tmdb.js';

/**
 * @param {string} releaseDate ISO date YYYY-MM-DD
 * @param {number} retentionDays
 * @param {string} [nowIso] date('now') equivalent YYYY-MM-DD
 */
export function isPastRetention(releaseDate, retentionDays, nowIso) {
  if (!releaseDate || !Number.isFinite(retentionDays)) return false;
  const now = nowIso || new Date().toISOString().slice(0, 10);
  const release = String(releaseDate).slice(0, 10);
  const expiry = addDaysToIsoDate(release, retentionDays);
  return expiry <= now;
}

function addDaysToIsoDate(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function safeFilenameBase(filmTitle, guid) {
  const slug = String(filmTitle || 'trailer')
    .replace(/[^\w\s.-]+/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  const id = String(guid || '')
    .replace(/[^\w-]+/g, '')
    .slice(-24);
  return `${slug || 'trailer'}_${id || 'item'}`;
}

export class TrailerFetcherService {
  /**
   * @param {{
   *   sql: object,
   *   fs: object,
   *   fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
   *   trailerAddict: { fetchFeed(): Promise<object[]>, fetchVideoUrl(url: string): Promise<string|null> },
   *   log: object,
   *   getSettings: () => object,
   *   getTmdbApiKey?: () => string,
   * }} opts
   */
  constructor({ sql, fs, fetchFn, trailerAddict, log, getSettings, getTmdbApiKey }) {
    this.sql = sql;
    this.fs = fs;
    this.fetchFn = fetchFn;
    this.trailerAddict = trailerAddict;
    this.logger = log;
    this.getSettings = getSettings || (() => ({}));
    this.getTmdbApiKey = getTmdbApiKey || (() => '');
  }

  getSettingsResolved() {
    const s = this.getSettings() || {};
    return {
      certRegion: String(s.certRegion || 'GB').trim() || 'GB',
      downloadFolder: String(s.downloadFolder || '').trim(),
      retentionDaysAfterRelease: Math.max(
        0,
        Number(s.retentionDaysAfterRelease ?? 7),
      ),
      pollIntervalMinutes: Math.max(1, Number(s.pollIntervalMinutes ?? 180)),
    };
  }

  createTmdbIfConfigured() {
    const cfg = getTmdbConfig(this.getSettings(), this.getTmdbApiKey());
    if (!cfg.apiKey) return null;
    try {
      return createTmdbClient({ ...cfg, fetchFn: this.fetchFn });
    } catch {
      return null;
    }
  }

  existingGuids(guids) {
    if (!guids.length) return new Set();
    const placeholders = guids.map(() => '?').join(',');
    const rows = this.sql
      .prepare(`SELECT guid FROM trailer_downloads WHERE guid IN (${placeholders})`)
      .all(...guids);
    return new Set(rows.map((r) => r.guid));
  }

  async checkForNewTrailers() {
    const { downloadFolder, certRegion } = this.getSettingsResolved();
    if (!downloadFolder) {
      this.logger.warn('Trailer Fetcher: downloadFolder is not set — skipping poll');
      return;
    }

    let items;
    try {
      items = await this.trailerAddict.fetchFeed();
    } catch (err) {
      this.logger.error(`TrailerAddict feed failed: ${err.message}`);
      return;
    }

    const known = this.existingGuids(items.map((i) => i.guid));
    const fresh = items.filter((i) => !known.has(i.guid));
    if (!fresh.length) {
      this.logger.debug('Trailer Fetcher: no new RSS items');
      return;
    }

    const tmdb = this.createTmdbIfConfigured();
    if (!tmdb) {
      this.logger.warn('Trailer Fetcher: TMDb key not set on the API keys page — metadata will be omitted');
    }

    await this.fs.mkdir(downloadFolder);

    for (const item of fresh) {
      try {
        await this.processNewItem(item, { downloadFolder, certRegion, tmdb });
      } catch (err) {
        this.logger.error(`Trailer Fetcher: failed "${item.title}": ${err.message}`);
      }
    }
  }

  async processNewItem(item, { downloadFolder, certRegion, tmdb }) {
    const filmTitle = cleanFilmTitle(item.title);
    let videoUrl = null;
    try {
      videoUrl = await this.trailerAddict.fetchVideoUrl(item.link);
    } catch (err) {
      this.logger.warn(`Could not resolve video URL for ${item.link}: ${err.message}`);
    }

    let tmdbId = null;
    let genres = null;
    let certificate = null;
    let releaseDate = null;

    if (tmdb) {
      try {
        const match = await tmdb.searchMovie(filmTitle);
        if (match) {
          tmdbId = match.tmdbId;
          if (match.releaseDate) releaseDate = match.releaseDate;
          const [info, genreList] = await Promise.all([
            tmdb.getReleaseInfo(tmdbId, certRegion),
            tmdb.getGenres(tmdbId),
          ]);
          certificate = info.certificate;
          if (info.releaseDate) releaseDate = info.releaseDate;
          genres = JSON.stringify(genreList);
        } else {
          this.logger.warn(`TMDB: no match for "${filmTitle}"`);
        }
      } catch (err) {
        this.logger.warn(`TMDB enrichment failed for "${filmTitle}": ${err.message}`);
      }
    }

    let filePath = null;
    let downloadedAt = null;

    if (videoUrl) {
      const res = await this.fetchFn(videoUrl);
      if (!res.ok) {
        throw new Error(`Video download failed: ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const filename = `${safeFilenameBase(filmTitle, item.guid)}.mp4`;
      filePath = path.join(downloadFolder, filename);
      await this.fs.writeFile(filePath, buf);
      downloadedAt = new Date().toISOString();
    } else {
      this.logger.warn(`No MP4 URL for "${item.title}" — recording metadata only`);
    }

    this.sql
      .prepare(
        `INSERT INTO trailer_downloads (
          guid, raw_title, film_title, traileraddict_url, video_url,
          tmdb_id, genres, certificate, release_date, file_path, downloaded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.guid,
        item.title,
        filmTitle,
        item.link,
        videoUrl,
        tmdbId,
        genres,
        certificate,
        releaseDate,
        filePath,
        downloadedAt,
      );

    this.logger.info(`Trailer Fetcher: saved "${filmTitle}"`, {
      guid: item.guid,
      file: filePath,
    });
  }

  async cleanupExpiredTrailers() {
    const { retentionDaysAfterRelease } = this.getSettingsResolved();
    const rows = this.sql
      .prepare(
        `SELECT id, guid, film_title, file_path, release_date
         FROM trailer_downloads
         WHERE removed_at IS NULL
           AND release_date IS NOT NULL
           AND date(release_date, '+' || ? || ' days') <= date('now')`,
      )
      .all(retentionDaysAfterRelease);

    for (const row of rows) {
      if (row.file_path) {
        try {
          if (this.fs.exists(row.file_path)) {
            await this.fs.unlink(row.file_path);
          }
        } catch (err) {
          this.logger.warn(`Could not delete ${row.file_path}: ${err.message}`);
        }
      }
      this.sql
        .prepare(
          `UPDATE trailer_downloads SET removed_at = datetime('now') WHERE id = ?`,
        )
        .run(row.id);
      this.logger.info(`Trailer Fetcher: removed expired "${row.film_title}"`, {
        guid: row.guid,
      });
    }

    const unmatched = this.sql
      .prepare(
        `SELECT film_title, guid FROM trailer_downloads
         WHERE removed_at IS NULL AND release_date IS NULL
         ORDER BY downloaded_at DESC
         LIMIT 50`,
      )
      .all();
    if (unmatched.length) {
      this.logger.warn(
        `Trailer Fetcher: ${unmatched.length} download(s) have no TMDB release date and will not auto-expire`,
        {
          titles: unmatched.map((r) => r.film_title),
        },
      );
    }
  }
}
