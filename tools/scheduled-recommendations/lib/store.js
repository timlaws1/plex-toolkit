import { titleKey } from './engine.js';

export function createStore(sql) {
  return {
    lastImport() {
      return sql.prepare(
        'SELECT * FROM rec_letterboxd_imports ORDER BY id DESC LIMIT 1',
      ).get();
    },

    filmCount() {
      return sql.prepare('SELECT COUNT(*) AS n FROM rec_letterboxd_films').get().n;
    },

    saveFilms(films) {
      const findSynthetic = sql.prepare(
        'SELECT id FROM rec_letterboxd_films WHERE letterboxd_uri = ?',
      );
      const retarget = sql.prepare(
        'UPDATE rec_letterboxd_films SET letterboxd_uri = ? WHERE id = ?',
      );
      const upsert = sql.prepare(`
        INSERT INTO rec_letterboxd_films (
          letterboxd_uri, title, year, rating, watched, watchlist, tags, review_excerpt, updated_at
        ) VALUES (
          @uri, @title, @year, @rating, @watched, @watchlist, @tags, @review, datetime('now')
        )
        ON CONFLICT(letterboxd_uri) DO UPDATE SET
          title = excluded.title,
          year = COALESCE(excluded.year, rec_letterboxd_films.year),
          rating = COALESCE(excluded.rating, rec_letterboxd_films.rating),
          watched = MAX(rec_letterboxd_films.watched, excluded.watched),
          watchlist = CASE
            WHEN excluded.watched = 1 THEN 0
            ELSE MAX(rec_letterboxd_films.watchlist, excluded.watchlist)
          END,
          tags = COALESCE(NULLIF(excluded.tags, ''), rec_letterboxd_films.tags),
          review_excerpt = COALESCE(NULLIF(excluded.review_excerpt, ''), rec_letterboxd_films.review_excerpt),
          updated_at = datetime('now')
      `);
      const activity = sql.prepare(`
        INSERT INTO rec_letterboxd_activity (
          film_id, kind, source, rss_guid, happened_on, rating, tags, review_excerpt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rss_guid) DO NOTHING
      `);
      const filmId = sql.prepare(
        'SELECT id FROM rec_letterboxd_films WHERE letterboxd_uri = ?',
      );

      const tx = sql.transaction((rows) => {
        for (const film of rows) {
          const uri = film.uri || syntheticUri(film.title, film.year);
          const synthetic = findSynthetic.get(syntheticUri(film.title, film.year));
          if (synthetic && uri !== syntheticUri(film.title, film.year)) {
            retarget.run(uri, synthetic.id);
          }
          upsert.run({
            uri,
            title: film.title,
            year: film.year,
            rating: film.rating,
            watched: film.watched ? 1 : 0,
            watchlist: film.watchlist ? 1 : 0,
            tags: film.tags || '',
            review: film.review || '',
          });
          const row = filmId.get(uri);
          for (const event of film.activity || []) {
            if (!event.rssGuid) continue;
            activity.run(
              row.id,
              event.kind,
              event.source,
              event.rssGuid,
              event.happenedOn,
              event.rating,
              event.tags || '',
              event.review || '',
            );
          }
        }
      });
      tx(films);
    },

    recordImport(filmCount, error) {
      sql.prepare(
        `INSERT INTO rec_letterboxd_imports (finished_at, film_count, error)
         VALUES (datetime('now'), ?, ?)`,
      ).run(filmCount, error);
    },

    ratedFilms() {
      return sql.prepare(
        `SELECT id, title, year, tmdb_id, rating, watched, tags
         FROM rec_letterboxd_films
         WHERE rating IS NOT NULL`,
      ).all();
    },

    watchedKeys() {
      const rows = sql.prepare(
        `SELECT title, year, tmdb_id FROM rec_letterboxd_films WHERE watched = 1`,
      ).all();
      const keys = new Set();
      for (const row of rows) {
        keys.add(titleKey(row.title, row.year));
        if (row.tmdb_id) keys.add(`tmdb:${row.tmdb_id}`);
      }
      return keys;
    },

    unresolvedFilms(limit) {
      return sql.prepare(
        `SELECT id, title, year FROM rec_letterboxd_films
         WHERE tmdb_id IS NULL
         ORDER BY rating DESC
         LIMIT ?`,
      ).all(limit);
    },

    setFilmTmdb(id, tmdbId) {
      sql.prepare(
        'UPDATE rec_letterboxd_films SET tmdb_id = ?, updated_at = datetime(\'now\') WHERE id = ?',
      ).run(tmdbId, id);
    },

    getTmdb(tmdbId) {
      return sql.prepare('SELECT * FROM rec_tmdb_movies WHERE tmdb_id = ?').get(tmdbId);
    },

    saveTmdb(movie) {
      sql.prepare(`
        INSERT INTO rec_tmdb_movies (
          tmdb_id, title, year, runtime, vote_average, genres, directors, actors, similar_ids,
          certification, fetched_at
        ) VALUES (
          @tmdbId, @title, @year, @runtime, @voteAverage, @genres, @directors, @actors, @similarIds,
          @certification, datetime('now')
        )
        ON CONFLICT(tmdb_id) DO UPDATE SET
          title = excluded.title,
          year = excluded.year,
          runtime = excluded.runtime,
          vote_average = excluded.vote_average,
          genres = excluded.genres,
          directors = excluded.directors,
          actors = excluded.actors,
          similar_ids = excluded.similar_ids,
          certification = excluded.certification,
          fetched_at = datetime('now')
      `).run({
        tmdbId: movie.tmdbId,
        title: movie.title,
        year: movie.year,
        runtime: movie.runtime,
        voteAverage: movie.voteAverage,
        genres: JSON.stringify(movie.genres || []),
        directors: JSON.stringify(movie.directors || []),
        actors: JSON.stringify(movie.actors || []),
        similarIds: JSON.stringify(movie.similarIds || []),
        certification: movie.certification ?? null,
      });
    },

    getStreaming(tmdbId, region) {
      return sql.prepare(
        'SELECT * FROM rec_streaming_cache WHERE tmdb_id = ? AND region = ?',
      ).get(tmdbId, region);
    },

    saveStreaming(tmdbId, region, providers) {
      sql.prepare(`
        INSERT INTO rec_streaming_cache (tmdb_id, region, providers, fetched_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(tmdb_id, region) DO UPDATE SET
          providers = excluded.providers,
          fetched_at = datetime('now')
      `).run(tmdbId, region, JSON.stringify(providers));
    },

    listSchedules() {
      return sql.prepare('SELECT * FROM rec_schedules ORDER BY id').all();
    },

    getSchedule(id) {
      return sql.prepare('SELECT * FROM rec_schedules WHERE id = ?').get(id);
    },

    saveSchedule(fields, id) {
      if (id) {
        sql.prepare(`
          UPDATE rec_schedules SET
            name = @name, enabled = @enabled, days = @days, time_local = @time_local,
            film_count = @film_count, runtime_min = @runtime_min, runtime_max = @runtime_max,
            prefer_plex = @prefer_plex, allow_streaming = @allow_streaming, genres = @genres,
            excluded_genres = @excluded_genres, rating_min = @rating_min, rating_max = @rating_max,
            output_type = @output_type, plex_section_id = @plex_section_id,
            replace_on_watch = @replace_on_watch, remove_watchlist = @remove_watchlist,
            certificate_max = @certificate_max, preset = @preset, updated_at = datetime('now')
          WHERE id = @id
        `).run({ ...fields, id });
        return id;
      }
      const result = sql.prepare(`
        INSERT INTO rec_schedules (
          name, enabled, days, time_local, film_count, runtime_min, runtime_max,
          prefer_plex, allow_streaming, genres, excluded_genres, rating_min, rating_max,
          output_type, plex_section_id, replace_on_watch, remove_watchlist, certificate_max, preset
        ) VALUES (
          @name, @enabled, @days, @time_local, @film_count, @runtime_min, @runtime_max,
          @prefer_plex, @allow_streaming, @genres, @excluded_genres, @rating_min, @rating_max,
          @output_type, @plex_section_id, @replace_on_watch, @remove_watchlist, @certificate_max, @preset
        )
      `).run(fields);
      return Number(result.lastInsertRowid);
    },

    setEnabled(id, enabled) {
      sql.prepare(
        'UPDATE rec_schedules SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?',
      ).run(enabled ? 1 : 0, id);
    },

    deleteSchedule(id) {
      sql.prepare('DELETE FROM rec_schedules WHERE id = ?').run(id);
    },

    setDestination(id, destinationId, title) {
      sql.prepare(
        `UPDATE rec_schedules
         SET plex_destination_id = ?, plex_destination_title = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).run(destinationId, title, id);
    },

    latestRunSlot(scheduleId) {
      const row = sql.prepare(
        `SELECT slot_date FROM rec_runs
         WHERE schedule_id = ? AND status = 'ok' AND slot_date NOT LIKE 'manual:%'
         ORDER BY id DESC LIMIT 1`,
      ).get(scheduleId);
      return row?.slot_date || null;
    },

    lastRun(scheduleId) {
      return sql.prepare(
        'SELECT * FROM rec_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1',
      ).get(scheduleId);
    },

    recordRun(scheduleId, slot, status, message) {
      sql.prepare(
        `INSERT INTO rec_runs (schedule_id, slot_date, status, message)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(schedule_id, slot_date) DO UPDATE SET
           status = excluded.status,
           message = excluded.message`,
      ).run(scheduleId, slot, status, message);
      return sql.prepare(
        'SELECT id FROM rec_runs WHERE schedule_id = ? AND slot_date = ?',
      ).get(scheduleId, slot).id;
    },

    recentKeys(sinceIso) {
      const rows = sql.prepare(
        `SELECT title, year, tmdb_id FROM rec_items WHERE recommended_at >= ?`,
      ).all(sinceIso);
      const keys = new Set();
      for (const row of rows) {
        keys.add(titleKey(row.title, row.year));
        if (row.tmdb_id) keys.add(`tmdb:${row.tmdb_id}`);
      }
      return keys;
    },

    ownedPlexKeys(scheduleId) {
      return sql.prepare(
        `SELECT plex_rating_key FROM rec_items
         WHERE schedule_id = ? AND active = 1 AND plex_rating_key IS NOT NULL`,
      ).all(scheduleId).map((row) => row.plex_rating_key);
    },

    replaceActiveItems(scheduleId, runId, picks) {
      const clear = sql.prepare(
        'UPDATE rec_items SET active = 0 WHERE schedule_id = ? AND active = 1',
      );
      const insert = sql.prepare(`
        INSERT INTO rec_items (
          schedule_id, run_id, position, title, year, tmdb_id,
          plex_rating_key, discover_rating_key, provider, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `);
      const tx = sql.transaction(() => {
        clear.run(scheduleId);
        picks.forEach((pick, index) => {
          insert.run(
            scheduleId,
            runId,
            index + 1,
            pick.title,
            pick.year,
            pick.tmdbId || null,
            pick.plexRatingKey || null,
            pick.discoverRatingKey || null,
            pick.provider || (pick.inLibrary ? 'plex' : 'streaming'),
          );
        });
      });
      tx();
    },

    activeByPlexKey(ratingKey) {
      return sql.prepare(
        `SELECT * FROM rec_items WHERE plex_rating_key = ? AND active = 1`,
      ).all(String(ratingKey));
    },

    markItemWatched(id) {
      sql.prepare(
        'UPDATE rec_items SET active = 0, watched_at = datetime(\'now\') WHERE id = ?',
      ).run(id);
    },

    addActiveItem(scheduleId, pick) {
      const position = sql.prepare(
        'SELECT COALESCE(MAX(position), 0) + 1 AS n FROM rec_items WHERE schedule_id = ? AND active = 1',
      ).get(scheduleId).n;
      sql.prepare(`
        INSERT INTO rec_items (
          schedule_id, position, title, year, tmdb_id,
          plex_rating_key, discover_rating_key, provider, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        scheduleId,
        position,
        pick.title,
        pick.year,
        pick.tmdbId || null,
        pick.plexRatingKey || null,
        pick.discoverRatingKey || null,
        pick.provider || (pick.inLibrary ? 'plex' : 'streaming'),
      );
    },
  };
}

export function syntheticUri(title, year) {
  return `synthetic:${titleKey(title, year)}`;
}

export function parseJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
