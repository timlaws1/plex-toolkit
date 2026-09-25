const DEFAULT_BASE = 'https://api.themoviedb.org/3';
const MOVIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PROVIDER_TTL_MS = 24 * 60 * 60 * 1000;

export function createTmdbClient({ apiKey, baseUrl = DEFAULT_BASE, fetchFn }) {
  async function get(pathname, params) {
    const url = new URL(pathname.replace(/^\//, ''), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    url.searchParams.set('api_key', apiKey);
    for (const [key, value] of Object.entries(params || {})) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    const res = await fetchFn(String(url));
    if (!res.ok) throw new Error(`TMDb ${pathname} failed: ${res.status}`);
    return res.json();
  }

  return {
    async searchMovie(title, year) {
      const data = await get('/search/movie', { query: title, year: year || undefined });
      const results = data.results || [];
      const exact = results.find((row) => row.title?.toLowerCase() === title.toLowerCase() && (!year || String(row.release_date || '').startsWith(String(year))));
      return exact || results[0] || null;
    },
    async movie(id) {
      return get(`/movie/${id}`, { append_to_response: 'credits,similar,release_dates' });
    },
    async providers(id) {
      return get(`/movie/${id}/watch/providers`);
    },
  };
}

export function mapTmdbMovie(data) {
  const year = data.release_date ? Number(String(data.release_date).slice(0, 4)) : null;
  const directors = (data.credits?.crew || [])
    .filter((person) => person.job === 'Director')
    .map((person) => person.name);
  const actors = (data.credits?.cast || []).slice(0, 8).map((person) => person.name);
  const similarIds = (data.similar?.results || []).slice(0, 12).map((row) => row.id);
  return {
    tmdbId: data.id,
    title: data.title,
    year: Number.isFinite(year) ? year : null,
    runtime: data.runtime || null,
    voteAverage: data.vote_average ?? null,
    genres: (data.genres || []).map((genre) => genre.name),
    directors,
    actors,
    similarIds,
    certification: gbCertification(data.release_dates),
  };
}

/** Empty string means TMDb had no GB certificate, so the film is not refetched for it. */
export function gbCertification(releaseDates) {
  const gb = (releaseDates?.results || []).find((row) => row.iso_3166_1 === 'GB');
  for (const release of gb?.release_dates || []) {
    const cert = String(release.certification || '').trim();
    if (cert) return cert;
  }
  return '';
}

export function providerNames(payload, region) {
  const country = payload?.results?.[String(region || 'GB').toUpperCase()];
  const names = [];
  for (const kind of ['flatrate', 'free', 'ads']) {
    for (const row of country?.[kind] || []) {
      if (row.provider_name && !names.includes(row.provider_name)) names.push(row.provider_name);
    }
  }
  return names;
}

export function cacheFresh(fetchedAt, ttlMs) {
  if (!fetchedAt) return false;
  const then = Date.parse(fetchedAt.includes('T') ? fetchedAt : `${fetchedAt.replace(' ', 'T')}Z`);
  if (!Number.isFinite(then)) return false;
  return Date.now() - then < ttlMs;
}

export { MOVIE_TTL_MS, PROVIDER_TTL_MS };
