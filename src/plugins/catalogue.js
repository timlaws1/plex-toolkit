import { getSetting, setSetting } from '../db/index.js';

export class Catalogue {
  constructor({ db, defaultUrl = '' }) {
    this.db = db;
    this.defaultUrl = defaultUrl;
  }

  getUrl() {
    return getSetting(this.db, 'catalogue_url', this.defaultUrl) || this.defaultUrl;
  }

  setUrl(url) {
    setSetting(this.db, 'catalogue_url', url || '');
  }

  async fetch() {
    const url = this.getUrl();
    if (!url) {
      return { plugins: [], error: 'No catalogue URL configured' };
    }
    const res = await fetch(url, {
      headers: { 'User-Agent': 'plex-toolkit', Accept: 'application/json' },
      redirect: 'follow',
    });
    if (!res.ok) {
      return { plugins: [], error: `Catalogue fetch failed: HTTP ${res.status}` };
    }
    const data = await res.json();
    const plugins = Array.isArray(data?.plugins) ? data.plugins : [];
    return {
      name: data.name || 'Plugin Repository',
      plugins: plugins.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description || '',
        repository: p.repository,
        author: p.author || null,
      })),
      error: null,
    };
  }
}
