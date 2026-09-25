import { COOLDOWN_DAYS, buildTaste, selectRecommendations, titleKey, tmdbIdFromGuids } from './engine.js';
import { renderRecommendationEmail } from './email.js';
import { filmsFromExportZip } from './letterboxd.js';
import { publishPicks, removePublishedItem } from './publish.js';
import { toBbfc } from './ratings.js';
import { activityRssUrl, parseLetterboxdRss } from './rss.js';
import { effectiveOutput, isScheduleDue, slotDate } from './schedule.js';
import { matchSelectedServices } from './services.js';
import { createStore, parseJsonList, syntheticUri } from './store.js';
import { cacheFresh, createTmdbClient, mapTmdbMovie, MOVIE_TTL_MS, PROVIDER_TTL_MS, providerNames } from './tmdb.js';

export class RecommendationsService {
  constructor({ sql, plex, log, fetchFn, getSettings, mail = null, now = () => new Date() }) {
    this.store = createStore(sql);
    this.plex = plex;
    this.log = log;
    this.fetchFn = fetchFn;
    this.getSettings = getSettings;
    this.mail = mail;
    this.now = now;
    this.running = false;
  }

  async importZip(buffer) {
    const films = filmsFromExportZip(buffer);
    this.store.saveFilms(films);
    this.store.recordImport(films.length, null);
    this.log.info(`Imported ${films.length} Letterboxd films`);
    await this.resolveTmdb(25);
    return films.length;
  }

  async checkRss() {
    const settings = this.getSettings() || {};
    let url;
    try {
      url = activityRssUrl(settings.letterboxdUsername, settings.letterboxdRssUrl);
    } catch (err) {
      this.log.info(`Letterboxd RSS skipped: ${err.message}`);
      return;
    }
    try {
      const res = await this.fetchFn(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const items = parseLetterboxdRss(await res.text());
      const films = items.map((item) => ({
        uri: item.uri || syntheticUri(item.title, item.year),
        title: item.title,
        year: item.year,
        rating: item.rating,
        watched: item.kind === 'watched' || item.kind === 'review' || item.kind === 'diary' ? 1 : 0,
        watchlist: item.kind === 'watchlist' ? 1 : 0,
        tags: '',
        review: '',
        activity: [{
          kind: item.kind,
          source: 'rss',
          rssGuid: item.guid,
          happenedOn: item.happenedOn,
          rating: item.rating,
          tags: '',
          review: '',
        }],
      }));
      if (films.length) this.store.saveFilms(films);
      this.log.info(`Letterboxd RSS updated ${films.length} items`);
    } catch (err) {
      this.log.warn(`Letterboxd RSS unavailable: ${err.message}`);
    }
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      for (const schedule of this.store.listSchedules()) {
        const ran = this.store.latestRunSlot(schedule.id);
        if (!isScheduleDue(schedule, now, ran)) continue;
        try {
          await this.runSchedule(schedule, slotDate(now));
        } catch (err) {
          this.log.error(`Schedule ${schedule.name} failed: ${err.message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  async runNow(scheduleId) {
    const schedule = this.store.getSchedule(scheduleId);
    if (!schedule) throw new Error('Schedule not found');
    const slot = `manual:${new Date().toISOString()}`;
    return this.runSchedule(schedule, slot);
  }

  /**
   * Pick films for a schedule without publishing, emailing, or recording a run.
   */
  async preview(scheduleId) {
    const schedule = this.store.getSchedule(scheduleId);
    if (!schedule) throw new Error('Schedule not found');
    await this.resolveTmdb(20);
    const picks = await this.recommend(schedule, schedule.film_count);
    return { schedule, picks };
  }

  async onMovieWatched(payload) {
    const ratingKey = String(payload?.ratingKey || '');
    if (!ratingKey) return;
    const items = this.store.activeByPlexKey(ratingKey);
    for (const item of items) {
      const schedule = this.store.getSchedule(item.schedule_id);
      if (!schedule) continue;
      this.store.markItemWatched(item.id);
      this.log.info(`Watched recommendation: ${item.title}`);
      try {
        await removePublishedItem(this.plex, schedule, item);
      } catch (err) {
        this.log.warn(`Could not remove ${item.title} from Plex: ${err.message}`);
      }
      if (!Number(schedule.replace_on_watch) || effectiveOutput(schedule) === 'email') continue;
      try {
        const [pick] = await this.recommend(schedule, 1);
        if (!pick) continue;
        await publishPicks(this.plex, schedule, [pick], []);
        this.store.addActiveItem(schedule.id, pick);
        this.log.info(`Replaced ${item.title} with ${pick.title}`);
      } catch (err) {
        this.log.warn(`Could not replace ${item.title}: ${err.message}`);
      }
    }
  }

  async runSchedule(schedule, slot) {
    this.log.info(`Running schedule: ${schedule.name}`);
    await this.resolveTmdb(20);
    const picks = await this.recommend(schedule, schedule.film_count);
    this.log.info(`Generating ${picks.length} recommendations`);
    const output = effectiveOutput(schedule);
    const plexCount = picks.filter((pick) => pick.inLibrary).length;
    const streamingCount = picks.length - plexCount;
    if (plexCount) this.log.info(`Matched ${plexCount} recommendations to Plex library`);
    if (streamingCount) this.log.info(`Found ${streamingCount} streaming recommendation${streamingCount === 1 ? '' : 's'}`);
    this.log.info(`Publishing to ${labelOutput(output)}`);

    let warning = null;
    if (output === 'email') {
      warning = await this.emailPicks(schedule, picks);
    } else {
      const owned = this.store.ownedPlexKeys(schedule.id);
      const published = await publishPicks(this.plex, { ...schedule, output_type: output }, picks, owned, (destinationId) => {
        this.store.setDestination(schedule.id, destinationId, schedule.name);
        schedule.plex_destination_id = destinationId;
      });
      if (published.destinationId && published.destinationId !== schedule.plex_destination_id) {
        this.store.setDestination(schedule.id, published.destinationId, schedule.name);
        schedule.plex_destination_id = published.destinationId;
      }
      warning = published.warning || null;
    }
    const runId = this.store.recordRun(schedule.id, slot, 'ok', warning || `${picks.length} films`);
    this.store.replaceActiveItems(schedule.id, runId, picks);
    this.log.info('Schedule completed');
    return picks;
  }

  /** @returns {Promise<string|null>} warning when nothing was sent */
  async emailPicks(schedule, picks) {
    if (!picks.length) return 'No films matched, so no email was sent';
    if (!this.mail?.isConfigured()) {
      throw new Error('Set up outgoing mail on the Mail page to email recommendations');
    }
    const to = String(this.getSettings()?.emailTo || '').trim() || this.mail.defaultTo();
    if (!to) throw new Error('Add a recipient in tool settings or on the Mail page');
    const { subject, text, html } = renderRecommendationEmail(schedule, picks);
    await this.mail.send({ to, subject, text, html });
    this.log.info(`Emailed ${picks.length} recommendations to ${to}`);
    return null;
  }

  async recommend(schedule, count) {
    const library = await this.loadLibrary();
    const watched = this.store.watchedKeys();
    const since = new Date(this.now().getTime() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    const recent = this.store.recentKeys(since);
    const tmdbIndex = await this.tasteMetadata();
    const taste = buildTaste(tmdbIndex.rated);
    const similarLiked = new Set();
    for (const film of tmdbIndex.rated) {
      if (Number(film.rating) < 4) continue;
      for (const id of film.similarIds || []) similarLiked.add(id);
    }

    const candidates = [];
    const seen = new Set();
    for (const movie of library) {
      const key = titleKey(movie.title, movie.year);
      const tmdbId = movie.tmdbId;
      const watchedFilm = movie.viewCount > 0 || watched.has(key) || (tmdbId && watched.has(`tmdb:${tmdbId}`));
      seen.add(key);
      if (tmdbId) seen.add(`tmdb:${tmdbId}`);
      const meta = tmdbId ? this.cachedMovie(tmdbId) : null;
      candidates.push({
        key,
        title: movie.title,
        year: movie.year,
        tmdbId,
        inLibrary: true,
        plexRatingKey: movie.ratingKey,
        discoverRatingKey: null,
        watched: watchedFilm,
        runtimeMinutes: minutes(movie.duration) ?? meta?.runtime ?? null,
        genres: movie.genres?.length ? movie.genres : meta?.genres || [],
        directors: movie.directors?.length ? names(movie.directors) : meta?.directors || [],
        actors: movie.roles?.length ? names(movie.roles) : meta?.actors || [],
        voteAverage: meta?.voteAverage ?? null,
        certificate: toBbfc(movie.contentRating) || toBbfc(meta?.certification),
        similarToLiked: Boolean(tmdbId && similarLiked.has(tmdbId)),
        provider: 'Plex',
        providers: ['Plex'],
      });
    }

    const output = effectiveOutput(schedule);
    const services = this.selectedServices();
    if (Number(schedule.allow_streaming) && output === 'email' && services.length) {
      for (const id of similarLiked) {
        if (seen.has(`tmdb:${id}`)) continue;
        const meta = this.cachedMovie(id);
        if (!meta) continue;
        const key = titleKey(meta.title, meta.year);
        if (seen.has(key) || watched.has(key) || watched.has(`tmdb:${id}`)) continue;
        seen.add(key);
        const matched = matchSelectedServices(await this.streamingNames(id), services);
        if (!matched.length) continue;
        candidates.push({
          key,
          title: meta.title,
          year: meta.year,
          tmdbId: id,
          inLibrary: false,
          plexRatingKey: null,
          discoverRatingKey: null,
          watched: false,
          runtimeMinutes: meta.runtime,
          genres: meta.genres,
          directors: meta.directors,
          actors: meta.actors,
          voteAverage: meta.voteAverage,
          certificate: toBbfc(meta.certification),
          similarToLiked: true,
          provider: matched[0],
          providers: matched,
        });
      }
    }

    const picks = selectRecommendations(candidates, taste, {
      count,
      recentKeys: recent,
      genres: schedule.genres,
      excludedGenres: schedule.excluded_genres,
      runtimeMin: schedule.runtime_min,
      runtimeMax: schedule.runtime_max,
      ratingMin: schedule.rating_min,
      ratingMax: schedule.rating_max,
      preferPlex: Number(schedule.prefer_plex) === 1,
      allowStreaming: Number(schedule.allow_streaming) === 1,
      output,
      certificateMax: schedule.certificate_max,
    });
    return picks;
  }

  selectedServices() {
    const value = this.getSettings()?.streamingServices;
    return Array.isArray(value) ? value.map(String) : [];
  }

  async loadLibrary() {
    if (!this.plex.isConfigured()) return [];
    const libraries = await this.plex.getLibraries();
    const movies = libraries.filter((lib) => lib.type === 'movie');
    const out = [];
    for (const lib of movies) {
      let start = 0;
      let total = Infinity;
      while (start < total) {
        const page = await this.plex.getLibraryItems(lib.id, { type: 1, start, size: 200 });
        total = page.total;
        for (const item of page.items) {
          out.push({ ...item, tmdbId: tmdbIdFromGuids(item.guids) });
        }
        if (!page.items.length) break;
        start += page.items.length;
      }
    }
    return out;
  }

  async tasteMetadata() {
    const rated = [];
    for (const film of this.store.ratedFilms()) {
      const meta = film.tmdb_id ? this.cachedMovie(film.tmdb_id) : null;
      rated.push({
        rating: film.rating,
        genres: meta?.genres || splitTags(film.tags),
        directors: meta?.directors || [],
        actors: meta?.actors || [],
        similarIds: meta?.similarIds || [],
      });
    }
    return { rated };
  }

  cachedMovie(tmdbId) {
    const row = this.store.getTmdb(tmdbId);
    if (!row || !cacheFresh(row.fetched_at, MOVIE_TTL_MS)) return row ? movieFromRow(row) : null;
    return movieFromRow(row);
  }

  async streamingNames(tmdbId) {
    const region = String(this.getSettings()?.watchRegion || 'GB').toUpperCase();
    const cached = this.store.getStreaming(tmdbId, region);
    if (cached && cacheFresh(cached.fetched_at, PROVIDER_TTL_MS)) return parseJsonList(cached.providers);
    const client = this.tmdb();
    if (!client) return [];
    try {
      const payload = await client.providers(tmdbId);
      const names = providerNames(payload, region);
      this.store.saveStreaming(tmdbId, region, names);
      return names;
    } catch (err) {
      this.log.warn(`Streaming availability unavailable: ${err.message}`);
      return [];
    }
  }

  async resolveTmdb(limit) {
    const client = this.tmdb();
    if (!client) return;
    const pending = this.store.unresolvedFilms(limit);
    for (const film of pending) {
      try {
        const found = await client.searchMovie(film.title, film.year);
        if (!found?.id) continue;
        this.store.setFilmTmdb(film.id, found.id);
        await this.ensureMovie(found.id, client);
      } catch (err) {
        this.log.warn(`TMDb lookup failed for ${film.title}: ${err.message}`);
        return;
      }
    }
    const liked = this.store.ratedFilms().filter((film) => film.tmdb_id && Number(film.rating) >= 4).slice(0, 8);
    for (const film of liked) {
      const row = this.store.getTmdb(film.tmdb_id);
      if (row && cacheFresh(row.fetched_at, MOVIE_TTL_MS)) {
        for (const id of parseJsonList(row.similar_ids).slice(0, 4)) {
          await this.ensureMovie(id, client);
        }
      }
    }
  }

  async ensureMovie(tmdbId, client = this.tmdb()) {
    if (!client || !tmdbId) return null;
    const existing = this.store.getTmdb(tmdbId);
    if (existing && existing.certification != null && cacheFresh(existing.fetched_at, MOVIE_TTL_MS)) {
      return movieFromRow(existing);
    }
    try {
      const mapped = mapTmdbMovie(await client.movie(tmdbId));
      this.store.saveTmdb(mapped);
      return mapped;
    } catch (err) {
      this.log.warn(`TMDb metadata unavailable for ${tmdbId}: ${err.message}`);
      return existing ? movieFromRow(existing) : null;
    }
  }

  tmdb() {
    const key = this.getSettings()?.tmdbApiKey;
    if (!key || !this.fetchFn) return null;
    return createTmdbClient({ apiKey: key, fetchFn: this.fetchFn });
  }
}

function movieFromRow(row) {
  return {
    tmdbId: row.tmdb_id,
    title: row.title,
    year: row.year,
    runtime: row.runtime,
    voteAverage: row.vote_average,
    genres: parseJsonList(row.genres),
    directors: parseJsonList(row.directors),
    actors: parseJsonList(row.actors),
    similarIds: parseJsonList(row.similar_ids),
    certification: row.certification ?? null,
  };
}

function names(people) {
  return (people || []).map((person) => person.tag || person).filter(Boolean);
}

function minutes(durationMs) {
  const n = Number(durationMs);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n / 60000);
}

function splitTags(value) {
  return String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function labelOutput(output) {
  if (output === 'playlist') return 'Plex playlist';
  if (output === 'email') return 'email';
  return 'Plex collection';
}
