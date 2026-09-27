/**
 * Minimal TMDB API client (fetch only).
 */
export function createTmdbClient({
  apiKey,
  baseUrl = 'https://api.themoviedb.org/3',
  fetchFn,
} = {}) {
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
    const res = await fetchFn(String(url), {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`TMDB ${path} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  return {
    async searchMovie(title) {
      const q = String(title || '').trim();
      if (!q) return null;
      const data = await get('/search/movie', {
        query: q,
        include_adult: 'false',
        language: 'en-US',
        page: '1',
      });
      const results = data.results || [];
      if (!results.length) return null;
      const exact = results.find(
        (row) => String(row.title || '').trim().toLowerCase() === q.toLowerCase(),
      );
      const row = exact || results[0];
      return {
        tmdbId: Number(row.id),
        title: String(row.title || '').trim(),
        releaseDate: row.release_date || null,
      };
    },

    async getReleaseInfo(tmdbId, region) {
      const data = await get(`/movie/${tmdbId}/release_dates`);
      const wanted = String(region || 'GB').toUpperCase();
      let entry = (data.results || []).find((r) => r.iso_3166_1 === wanted);
      if (!entry?.release_dates?.length) {
        entry = (data.results || []).find((r) => r.iso_3166_1 === 'US');
      }
      const dates = entry?.release_dates || [];
      let certificate = null;
      let releaseDate = null;
      for (const row of dates) {
        const cert = String(row.certification || '').trim();
        if (cert && !certificate) certificate = cert;
        const d = row.release_date ? String(row.release_date).slice(0, 10) : null;
        if (d && (!releaseDate || d < releaseDate)) releaseDate = d;
      }
      return { certificate, releaseDate };
    },

    async getGenres(tmdbId) {
      const data = await get(`/movie/${tmdbId}`, { language: 'en-US' });
      return (data.genres || []).map((g) => String(g.name || '').trim()).filter(Boolean);
    },
  };
}

export function getTmdbConfig(settings = {}) {
  return {
    apiKey: settings.tmdbApiKey || '',
    baseUrl: settings.tmdbBaseUrl || 'https://api.themoviedb.org/3',
  };
}
