import { productHeaders } from './auth.js';

const DISCOVER_BASES = [
  'https://discover.provider.plex.tv',
  'https://metadata.provider.plex.tv',
];

const WATCHLIST_URLS = [
  'https://discover.provider.plex.tv/library/sections/watchlist/all',
  'https://metadata.provider.plex.tv/library/sections/watchlist/all',
];

const WATCHLIST_PAGE_SIZE = 50;

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function mapPeople(raw) {
  return asList(raw)
    .map((p) => ({
      id: p.id != null ? String(p.id) : null,
      tag: String(p.tag || '').trim(),
      role: p.role != null ? String(p.role) : null,
      thumb: p.thumb || null,
    }))
    .filter((p) => p.tag);
}

function mapGuids(raw) {
  return asList(raw)
    .map((g) => (typeof g === 'string' ? g : g?.id))
    .filter((id) => typeof id === 'string' && id.length > 0);
}

function mapGenres(raw) {
  return asList(raw)
    .map((g) => String(g.tag || g || '').trim())
    .filter(Boolean);
}

function extractSearchResults(data) {
  const container = data?.MediaContainer || {};
  const hubs = asList(container.Hub);
  const direct = asList(container.Metadata);
  const searchGroups = asList(container.SearchResults);
  const external = searchGroups.filter((group) => group?.id === 'external');
  const groups = external.length > 0 ? external : searchGroups;
  const results = [];
  const seen = new Set();

  const pushItem = (item) => {
    if (!item || typeof item !== 'object') return;
    const metas = item.ratingKey
      ? [item]
      : asList(item.Metadata);
    for (const meta of metas) {
      if (!meta?.ratingKey) continue;
      const type = meta.type;
      if (type !== 'movie' && type !== 'show') continue;
      const key = String(meta.ratingKey);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(mapMetadata(meta));
    }
  };

  for (const hub of hubs) {
    for (const item of asList(hub.Metadata)) pushItem(item);
  }
  for (const group of groups) {
    for (const item of asList(group.SearchResult ?? group.Metadata)) pushItem(item);
  }
  for (const item of direct) pushItem(item);
  return results;
}

function mapLibraryItem(item, libraryId) {
  const guids = mapGuids(item.Guid ?? item.guid);
  return {
    ratingKey: String(item.ratingKey),
    type: item.type || null,
    title: item.title || null,
    year: item.year != null ? Number(item.year) : null,
    librarySectionID: String(item.librarySectionID ?? libraryId ?? ''),
    viewCount: Number(item.viewCount || 0),
    lastViewedAt: item.lastViewedAt || null,
    leafCount: item.leafCount != null ? Number(item.leafCount) : null,
    viewedLeafCount:
      item.viewedLeafCount != null ? Number(item.viewedLeafCount) : null,
    duration: item.duration || null,
    guid: typeof item.guid === 'string' ? item.guid : null,
    guids,
    roles: mapPeople(item.Role),
    directors: mapPeople(item.Director),
    writers: mapPeople(item.Writer),
    genres: mapGenres(item.Genre),
  };
}

function mapMetadata(item) {
  if (!item) return null;
  return {
    ratingKey: String(item.ratingKey),
    type: item.type,
    title: item.title,
    year: item.year != null ? Number(item.year) : null,
    parentIndex: item.parentIndex != null ? Number(item.parentIndex) : null,
    index: item.index != null ? Number(item.index) : null,
    grandparentRatingKey: item.grandparentRatingKey
      ? String(item.grandparentRatingKey)
      : null,
    grandparentTitle: item.grandparentTitle || null,
    parentRatingKey: item.parentRatingKey
      ? String(item.parentRatingKey)
      : null,
    librarySectionID: item.librarySectionID
      ? String(item.librarySectionID)
      : null,
    viewCount: Number(item.viewCount || 0),
    lastViewedAt: item.lastViewedAt || null,
    duration: item.duration || null,
    viewOffset: item.viewOffset || 0,
    leafCount: item.leafCount != null ? Number(item.leafCount) : null,
    viewedLeafCount:
      item.viewedLeafCount != null ? Number(item.viewedLeafCount) : null,
    guid: typeof item.guid === 'string' ? item.guid : null,
    guids: mapGuids(item.Guid ?? item.guid),
    roles: mapPeople(item.Role),
    directors: mapPeople(item.Director),
    writers: mapPeople(item.Writer),
    genres: mapGenres(item.Genre),
  };
}

export class PlexClient {
  constructor({ url, token, clientId, logger }) {
    this.url = (url || '').replace(/\/$/, '');
    this.token = token || '';
    this.clientId = clientId || 'plex-toolkit';
    this.logger = logger;
  }

  setCredentials({ url, token, clientId }) {
    if (url != null) this.url = String(url).replace(/\/$/, '');
    if (token != null) this.token = token;
    if (clientId != null) this.clientId = clientId;
  }

  isConfigured() {
    return Boolean(this.url && this.token);
  }

  hasToken() {
    return Boolean(this.token);
  }

  headers(extra = {}) {
    return {
      ...productHeaders(this.clientId, this.token),
      ...extra,
    };
  }

  async request(method, pathname, { query = {}, body } = {}) {
    if (!this.url) throw new Error('Plex server URL is not configured');
    if (!this.token) throw new Error('Plex token is not configured');

    const url = new URL(pathname, this.url.endsWith('/') ? this.url : `${this.url}/`);
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    if (!url.searchParams.has('X-Plex-Token')) {
      url.searchParams.set('X-Plex-Token', this.token);
    }

    const res = await fetch(url, {
      method,
      headers: this.headers(body ? { 'Content-Type': 'application/json' } : {}),
      body: body != null ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Plex ${method} ${pathname} failed: ${res.status} ${text.slice(0, 200)}`);
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json') || ct.includes('text/json')) {
      return res.json();
    }
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async accountRequest(method, base, pathname, { query = {} } = {}) {
    if (!this.token) throw new Error('Plex token is not configured');

    const url = new URL(pathname, base.endsWith('/') ? base : `${base}/`);
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    if (!url.searchParams.has('X-Plex-Token')) {
      url.searchParams.set('X-Plex-Token', this.token);
    }

    const res = await fetch(url, {
      method,
      headers: this.headers(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Plex Discover ${method} ${pathname} failed: ${res.status} ${text.slice(0, 200)}`,
      );
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json') || ct.includes('text/json')) {
      return res.json();
    }
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async getServer() {
    const data = await this.request('GET', '/');
    const media = data?.MediaContainer || data || {};
    return {
      name: media.friendlyName || media.machineIdentifier || 'Plex',
      version: media.version || null,
      machineId: media.machineIdentifier || null,
      platform: media.platform || null,
      myPlexUsername: media.myPlexUsername || null,
      myPlexSigninState: media.myPlexSigninState || null,
    };
  }

  async getTokenAccount() {
    const { fetchPlexAccount } = await import('./auth.js');
    return fetchPlexAccount(this.clientId, this.token);
  }

  async getLibraries() {
    const data = await this.request('GET', '/library/sections');
    const dirs = data?.MediaContainer?.Directory || [];
    return dirs.map((d) => ({
      id: String(d.key),
      title: d.title,
      type: d.type,
      agent: d.agent,
      scanner: d.scanner,
    }));
  }

  /**
   * Trigger a library section scan (partial refresh).
   * @param {string|number} sectionId
   */
  async refreshLibrary(sectionId) {
    const id = String(sectionId || '').trim();
    if (!id) throw new Error('Library section id is required');
    await this.request('GET', `/library/sections/${encodeURIComponent(id)}/refresh`);
    return { ok: true, sectionId: id };
  }

  /**
   * Paged library listing for movies (type=1) or shows (type=2).
   * @param {string} libraryId
   * @param {{ type?: number|string, start?: number, size?: number }} [opts]
   */
  async getLibraryItems(libraryId, opts = {}) {
    const type =
      opts.type === 'movie' || opts.type === 1 || opts.type === '1'
        ? 1
        : opts.type === 'show' || opts.type === 2 || opts.type === '2'
          ? 2
          : opts.type != null
            ? Number(opts.type)
            : null;
    const start = Math.max(0, Number(opts.start || 0));
    const size = Math.min(200, Math.max(1, Number(opts.size || 100)));

    const query = {
      'X-Plex-Container-Start': start,
      'X-Plex-Container-Size': size,
      includeGuids: '1',
    };
    if (Number.isFinite(type)) query.type = type;

    const data = await this.request(
      'GET',
      `/library/sections/${libraryId}/all`,
      { query },
    );
    const items = data?.MediaContainer?.Metadata || [];
    const total = Number(
      data?.MediaContainer?.totalSize ?? data?.MediaContainer?.size ?? items.length,
    );
    return {
      items: items.map((item) => mapLibraryItem(item, libraryId)),
      total,
      start,
      size,
    };
  }

  async getShows(libraryId) {
    const data = await this.request(
      'GET',
      `/library/sections/${libraryId}/all`,
      { query: { type: 2, includeGuids: '1' } },
    );
    const items = data?.MediaContainer?.Metadata || [];
    return items.map((s) => ({
      ratingKey: String(s.ratingKey),
      title: s.title,
      year: s.year,
      librarySectionID: String(s.librarySectionID ?? libraryId),
      leafCount: s.leafCount,
      viewedLeafCount: s.viewedLeafCount,
      viewCount: Number(s.viewCount || 0),
      lastViewedAt: s.lastViewedAt || null,
      guid: typeof s.guid === 'string' ? s.guid : null,
      guids: mapGuids(s.Guid ?? s.guid),
      roles: mapPeople(s.Role),
      directors: mapPeople(s.Director),
      writers: mapPeople(s.Writer),
      genres: mapGenres(s.Genre),
    }));
  }

  async getEpisodes(showRatingKey) {
    const data = await this.request(
      'GET',
      `/library/metadata/${showRatingKey}/allLeaves`,
    );
    const items = data?.MediaContainer?.Metadata || [];
    return items
      .map((e) => ({
        ratingKey: String(e.ratingKey),
        title: e.title,
        parentRatingKey: e.parentRatingKey ? String(e.parentRatingKey) : null,
        grandparentRatingKey: e.grandparentRatingKey
          ? String(e.grandparentRatingKey)
          : String(showRatingKey),
        grandparentTitle: e.grandparentTitle || null,
        parentIndex: Number(e.parentIndex ?? 0),
        index: Number(e.index ?? 0),
        viewCount: Number(e.viewCount || 0),
        lastViewedAt: e.lastViewedAt || null,
        duration: e.duration || null,
        type: e.type || 'episode',
        guid: typeof e.guid === 'string' ? e.guid : null,
        guids: mapGuids(e.Guid ?? e.guid),
      }))
      .sort((a, b) => {
        if (a.parentIndex !== b.parentIndex) return a.parentIndex - b.parentIndex;
        return a.index - b.index;
      });
  }

  async getMetadata(ratingKey) {
    const data = await this.request('GET', `/library/metadata/${ratingKey}`, {
      query: { includeGuids: '1' },
    });
    const item = data?.MediaContainer?.Metadata?.[0];
    return mapMetadata(item);
  }

  async getWatchState(ratingKey) {
    const meta = await this.getMetadata(ratingKey);
    if (!meta) return null;
    return {
      ratingKey: meta.ratingKey,
      watched: meta.viewCount > 0,
      viewCount: meta.viewCount,
      viewOffset: meta.viewOffset || 0,
    };
  }

  async markWatched(ratingKey) {
    // PMS expects GET with the numeric ratingKey (not PUT /library/metadata/...).
    await this.request('GET', '/:/scrobble', {
      query: {
        key: String(ratingKey),
        identifier: 'com.plexapp.plugins.library',
      },
    });
  }

  async markUnwatched(ratingKey) {
    await this.request('GET', '/:/unscrobble', {
      query: {
        key: String(ratingKey),
        identifier: 'com.plexapp.plugins.library',
      },
    });
  }

  async getWatchlist() {
    if (!this.token) throw new Error('Plex token is not configured');

    let lastError = null;
    for (const listUrl of WATCHLIST_URLS) {
      try {
        const all = [];
        let start = 0;
        let total = Infinity;

        while (start < total) {
          const url = new URL(listUrl);
          url.searchParams.set('includeGuids', '1');
          url.searchParams.set('includeMeta', '1');
          url.searchParams.set('X-Plex-Container-Start', String(start));
          url.searchParams.set('X-Plex-Container-Size', String(WATCHLIST_PAGE_SIZE));
          url.searchParams.set('X-Plex-Token', this.token);

          const res = await fetch(url, { headers: this.headers() });
          if (!res.ok) {
            lastError = `HTTP ${res.status} from ${listUrl}`;
            break;
          }

          const data = await res.json();
          const metadata = asList(data?.MediaContainer?.Metadata);
          total = Number(
            data?.MediaContainer?.totalSize ?? start + metadata.length,
          );
          const size = Number(data?.MediaContainer?.size ?? metadata.length);

          for (const row of metadata) {
            all.push(mapLibraryItem(row, null));
          }

          if (metadata.length === 0) break;
          start += Math.max(metadata.length, size);
        }

        if (all.length > 0 || lastError == null) {
          return all;
        }
      } catch (err) {
        lastError = err.message;
      }
    }

    throw new Error(lastError || 'Plex watchlist request failed');
  }

  /**
   * Add a Discover item to the account watchlist.
   * @param {string|number} ratingKey
   */
  async addToWatchlist(ratingKey) {
    if (!this.token) throw new Error('Plex token is not configured');
    const key = String(ratingKey || '').trim();
    if (!key) throw new Error('ratingKey is required');

    let lastError = null;
    for (const base of DISCOVER_BASES) {
      try {
        await this.accountRequest('PUT', base, '/actions/addToWatchlist', {
          query: { ratingKey: key },
        });
        return { ok: true, ratingKey: key };
      } catch (err) {
        lastError = err.message;
      }
    }
    throw new Error(lastError || 'Plex addToWatchlist failed');
  }

  async searchDiscover(query, { limit = 20 } = {}) {
    if (!this.token) throw new Error('Plex token is not configured');
    const q = String(query || '').trim();
    if (!q) return [];

    const capped = Math.min(50, Math.max(1, limit));
    // Discover title search. /hubs/search is a PMS route and 404s here.
    // /library/search on metadata.provider 404s with "Missing library search";
    // the working call is discover.provider plus searchProviders=discover.
    const discoverQuery = {
      query: q,
      limit: capped,
      searchTypes: 'movies,tv',
      searchProviders: 'discover',
      includeMetadata: '1',
      includeGuids: '1',
    };

    let lastError = null;
    let sawSuccess = false;

    try {
      const data = await this.accountRequest(
        'GET',
        DISCOVER_BASES[0],
        '/library/search',
        { query: discoverQuery },
      );
      sawSuccess = true;
      const results = extractSearchResults(data);
      if (results.length > 0) return results;
    } catch (err) {
      lastError = err.message;
    }

    if (this.url) {
      try {
        const data = await this.request('GET', '/hubs/search', {
          query: {
            query: q,
            limit: capped,
            includeGuids: '1',
          },
        });
        sawSuccess = true;
        const results = extractSearchResults(data);
        if (results.length > 0) return results;
      } catch (err) {
        lastError = err.message;
      }
    }

    if (!sawSuccess && lastError) throw new Error(lastError);
    return [];
  }

  async getDiscoverMetadata(ratingKeyOrPath) {
    if (!this.token) throw new Error('Plex token is not configured');

    let path = String(ratingKeyOrPath || '');
    if (!path.startsWith('/')) {
      path = `/library/metadata/${path}`;
    }

    let lastError = null;
    for (const base of DISCOVER_BASES) {
      try {
        const data = await this.accountRequest('GET', base, path, {
          query: { includeGuids: '1' },
        });
        const item = asList(data?.MediaContainer?.Metadata)[0];
        if (item) return mapMetadata(item);
      } catch (err) {
        lastError = err.message;
      }
    }
    throw new Error(lastError || 'Plex Discover metadata request failed');
  }

  /**
   * Flatten nested objects into Plex-style bracket query keys:
   * { hints: { title: 'X' } } → { 'hints[title]': 'X' }
   */
  static flattenQuery(query = {}) {
    const out = {};
    for (const [key, value] of Object.entries(query || {})) {
      if (value == null) continue;
      if (
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !(value instanceof Date)
      ) {
        for (const [k, v] of Object.entries(value)) {
          if (v == null) continue;
          out[`${key}[${k}]`] = v;
        }
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  async getDvrs() {
    const data = await this.request('GET', '/livetv/dvrs');
    const container = data?.MediaContainer || data || {};
    return {
      dvrs: asList(container.Dvr).map((d) => ({
        key: d.key != null ? String(d.key) : null,
        uuid: d.uuid || null,
        language: d.language || null,
        lineup: d.lineup || null,
        make: d.make || null,
        model: d.model || null,
        status: d.status != null ? String(d.status) : null,
      })),
      channelMappings: asList(container.ChannelMapping).map((c) => ({
        channelKey: c.channelKey || null,
        deviceIdentifier: c.deviceIdentifier || null,
        lineupIdentifier: c.lineupIdentifier || null,
        enabled: c.enabled === '1' || c.enabled === 1 || c.enabled === true,
      })),
    };
  }

  /**
   * Channel titles from each DVR (for regional preference detection).
   */
  async getDvrChannels() {
    const { dvrs } = await this.getDvrs();
    const channels = [];
    const seen = new Set();

    for (const dvr of dvrs) {
      if (!dvr.key) continue;
      try {
        const data = await this.request('GET', `/livetv/dvrs/${dvr.key}`);
        const container = data?.MediaContainer || data || {};
        for (const ch of asList(container.Channel)) {
          const title =
            ch.title ||
            ch.callSign ||
            ch.channelIdentifier ||
            ch.tag ||
            null;
          if (!title) continue;
          const key = String(title).toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          channels.push({
            title: String(title),
            dvrKey: dvr.key,
            channelIdentifier: ch.channelIdentifier || null,
            key: ch.key != null ? String(ch.key) : null,
          });
        }
        // Some servers nest channels under Lineup / VMap
        for (const lineup of asList(container.Lineup)) {
          for (const ch of asList(lineup.Channel)) {
            const title = ch.title || ch.callSign || null;
            if (!title) continue;
            const key = String(title).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            channels.push({
              title: String(title),
              dvrKey: dvr.key,
              channelIdentifier: ch.channelIdentifier || null,
              key: ch.key != null ? String(ch.key) : null,
            });
          }
        }
      } catch {
        // Individual DVR detail may fail; keep going
      }
    }

    // Fallback: Live TV library sections often expose channel titles
    if (channels.length === 0) {
      try {
        const sections = await this.getLibraries();
        for (const section of sections) {
          const type = String(section.type || '').toLowerCase();
          if (type !== 'livetv' && type !== 'show' && !/live/i.test(section.title || '')) {
            continue;
          }
          if (type !== 'livetv') continue;
          const result = await this.getLibraryItems(section.id, {
            size: 200,
          });
          for (const item of result.items || []) {
            const title = item.title;
            if (!title) continue;
            const key = String(title).toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            channels.push({ title: String(title), dvrKey: null });
          }
        }
      } catch {
        // ignore
      }
    }

    return channels;
  }

  async getSubscriptions({ includeGrabs = false } = {}) {
    const data = await this.request('GET', '/media/subscriptions', {
      query: { includeGrabs: includeGrabs ? '1' : '0' },
    });
    const container = data?.MediaContainer || data || {};
    return asList(container.MediaSubscription).map((s) => ({
      key: s.key != null ? String(s.key) : null,
      type: s.type != null ? Number(s.type) : null,
      title: s.title || null,
      targetLibrarySectionID:
        s.targetLibrarySectionID != null
          ? Number(s.targetLibrarySectionID)
          : null,
    }));
  }

  /**
   * List media providers (includes DVR / EPG providers used for subscriptions).
   */
  async getMediaProviders() {
    const data = await this.request('GET', '/media/providers');
    const container = data?.MediaContainer || data || {};
    return asList(container.MediaProvider).map((p) => ({
      id: p.id != null ? String(p.id) : null,
      identifier: p.identifier || null,
      title: p.title || null,
      protocols: asList(p.Protocol).map((x) => x.protocol || x),
      features: asList(p.Feature).map((f) => ({
        type: f.type || null,
        key: f.key || null,
        flavor: f.flavor || null,
      })),
    }));
  }

  /**
   * Prefer an EPG/Live TV provider that supports recording subscriptions.
   */
  async getDvrMediaProviderId() {
    const providers = await this.getMediaProviders();
    for (const p of providers) {
      const hasSubscribe = (p.features || []).some(
        (f) =>
          String(f.type || '').toLowerCase() === 'subscribe' ||
          String(f.flavor || '').toLowerCase() === 'record',
      );
      const looksEpg =
        /epg|livetv|dvr|tv\.plex\.providers\.epg/i.test(
          String(p.identifier || ''),
        ) || /epg|live\s*tv|dvr/i.test(String(p.title || ''));
      if (p.id && (hasSubscribe || looksEpg)) {
        return String(p.id);
      }
    }
    const first = providers.find((p) => p.id);
    return first?.id ? String(first.id) : null;
  }

  /**
   * Templates for recording a piece of media (one-shot, season, series, …).
   * @param {string} guid
   */
  async getSubscriptionTemplates(guid) {
    const g = String(guid || '').trim();
    if (!g) throw new Error('guid is required for subscription template');
    const data = await this.request('GET', '/media/subscriptions/template', {
      query: { guid: g },
    });
    const container = data?.MediaContainer || data || {};
    const groups = asList(container.SubscriptionTemplate);
    const out = [];
    for (const group of groups) {
      for (const sub of asList(group.MediaSubscription)) {
        out.push({
          title: sub.title || null,
          type: sub.type != null ? Number(sub.type) : null,
          selected: Boolean(sub.selected),
          targetLibrarySectionID:
            sub.targetLibrarySectionID != null
              ? Number(sub.targetLibrarySectionID)
              : null,
          parameters: sub.parameters || '',
          airingsType: sub.airingsType || null,
        });
      }
    }
    return out;
  }

  /**
   * Create a DVR / media subscription.
   * Pass nested objects for hints/prefs/params; they are flattened to bracket keys.
   * Prefer getSubscriptionTemplates() + createSubscriptionFromTemplate() for recordings.
   */
  async createSubscription(options = {}) {
    const query = this.constructor.flattenQuery(options);
    const data = await this.request('POST', '/media/subscriptions', { query });
    const container = data?.MediaContainer || data || {};
    const sub = asList(container.MediaSubscription)[0];
    if (!sub) return { key: null, raw: data };
    return {
      key: sub.key != null ? String(sub.key) : null,
      type: sub.type != null ? Number(sub.type) : null,
      title: sub.title || null,
      targetLibrarySectionID:
        sub.targetLibrarySectionID != null
          ? Number(sub.targetLibrarySectionID)
          : null,
      raw: sub,
    };
  }

  /**
   * Create a subscription using a template `parameters` query string from
   * getSubscriptionTemplates(), merged with target library / prefs overrides.
   */
  async createSubscriptionFromTemplate(
    parameters,
    { targetLibrarySectionID, prefs = {} } = {},
  ) {
    const query = parseQueryString(parameters);
    if (targetLibrarySectionID != null) {
      query.targetLibrarySectionID = String(targetLibrarySectionID);
    }
    for (const [k, v] of Object.entries(prefs || {})) {
      if (v == null) continue;
      query[`prefs[${k}]`] = v;
    }
    if (query['prefs[oneShot]'] == null) {
      query['prefs[oneShot]'] = '1';
    }
    const data = await this.request('POST', '/media/subscriptions', { query });
    const container = data?.MediaContainer || data || {};
    const sub = asList(container.MediaSubscription)[0];
    if (!sub) return { key: null, raw: data };
    return {
      key: sub.key != null ? String(sub.key) : null,
      type: sub.type != null ? Number(sub.type) : null,
      title: sub.title || null,
      targetLibrarySectionID:
        sub.targetLibrarySectionID != null
          ? Number(sub.targetLibrarySectionID)
          : null,
      raw: sub,
    };
  }

  websocketUrl() {
    if (!this.url || !this.token) return null;
    const u = new URL(this.url);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${u.host}/:/websockets/notifications?X-Plex-Token=${encodeURIComponent(this.token)}`;
  }
}

function parseQueryString(raw) {
  const out = {};
  const text = String(raw || '').trim();
  if (!text) return out;
  const params = new URLSearchParams(text);
  for (const [k, v] of params.entries()) {
    out[k] = v;
  }
  return out;
}

export {
  mapPeople,
  mapGuids,
  mapGenres,
  mapLibraryItem,
  mapMetadata,
  asList,
};
