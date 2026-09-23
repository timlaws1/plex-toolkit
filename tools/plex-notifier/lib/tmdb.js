/**
 * Minimal TMDB API client (fetch only).
 */
export function createTmdbClient({ apiKey, baseUrl = 'https://api.themoviedb.org/3' } = {}) {
  const key = String(apiKey || '').trim();
  const base = String(baseUrl || 'https://api.themoviedb.org/3').replace(/\/$/, '');

  if (!key) {
    throw new Error('TMDB API key is not configured');
  }

  async function get(path, query = {}) {
    const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
    url.searchParams.set('api_key', key);
    for (const [k, v] of Object.entries(query)) {
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`TMDB ${path} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  return {
    async searchPerson(query, { page = 1, limit = 10 } = {}) {
      const q = String(query || '').trim();
      if (!q) return [];
      const data = await get('/search/person', {
        query: q,
        include_adult: 'false',
        language: 'en-US',
        page: String(Math.max(1, page)),
      });
      return (data.results || []).slice(0, limit).map(mapPerson);
    },

    async personMovieCredits(personId) {
      const data = await get(`/person/${personId}/movie_credits`, {
        language: 'en-US',
      });
      return mapCredits(data, 'movie');
    },

    async personTvCredits(personId) {
      const data = await get(`/person/${personId}/tv_credits`, {
        language: 'en-US',
      });
      return mapCredits(data, 'tv');
    },

    async personFilmography(personId) {
      const [movies, tv] = await Promise.all([
        this.personMovieCredits(personId),
        this.personTvCredits(personId),
      ]);
      return [...movies, ...tv];
    },
  };
}

function mapPerson(row) {
  return {
    tmdbPersonId: Number(row.id),
    name: String(row.name || '').trim(),
    profilePath: row.profile_path || null,
    knownForDepartment: row.known_for_department || null,
    popularity: row.popularity ?? null,
  };
}

function mapCredits(data, mediaType) {
  const out = [];
  const seen = new Set();

  const push = (row, role) => {
    const id = Number(row.id);
    if (!Number.isFinite(id) || !row.title && !row.name) return;
    const key = `${mediaType}:${id}:${role}`;
    if (seen.has(key)) return;
    seen.add(key);
    const title = String(row.title || row.name || '').trim();
    const date = row.release_date || row.first_air_date || '';
    const year = date ? Number(String(date).slice(0, 4)) : null;
    out.push({
      tmdbId: id,
      mediaType,
      title,
      year: Number.isFinite(year) && year > 1800 ? year : null,
      role,
    });
  };

  for (const row of data.cast || []) push(row, 'cast');
  for (const row of data.crew || []) {
    const job = String(row.job || '').toLowerCase();
    const dept = String(row.department || '').toLowerCase();
    if (job === 'director' || dept === 'directing' || job === 'writer' || dept === 'writing') {
      push(row, job || dept || 'crew');
    }
  }

  return out;
}

export function getTmdbConfig(settings = {}) {
  return {
    apiKey: settings.tmdbApiKey || '',
    baseUrl: settings.tmdbBaseUrl || 'https://api.themoviedb.org/3',
  };
}
