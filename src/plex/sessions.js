const PROGRESS_THROTTLE_MS = 30_000;

export class SessionTracker {
  constructor({ plex, bus, logger }) {
    this.plex = plex;
    this.bus = bus;
    this.logger = logger;
    /** @type {Map<string, object>} */
    this.sessions = new Map();
  }

  sessionKey(sessionKey, ratingKey, accountId) {
    return `${accountId || '0'}:${sessionKey || ratingKey}`;
  }

  async onPlay(raw) {
    const session = await this._buildSession(raw, true);
    if (!session) return;
    this.sessions.set(session.key, session);
    this.bus.publish('playback.started', this._payload(session));
  }

  async onProgress(raw) {
    const key = this.sessionKey(raw.sessionKey, raw.ratingKey, raw.accountId);
    let session = this.sessions.get(key);
    if (!session) {
      session = await this._buildSession(raw, true);
      if (!session) return;
      this.sessions.set(session.key, session);
      this.bus.publish('playback.started', this._payload(session));
    } else {
      this._updateProgress(session, raw);
    }

    const now = Date.now();
    if (
      session.lastProgressEmit &&
      now - session.lastProgressEmit < PROGRESS_THROTTLE_MS
    ) {
      return;
    }
    session.lastProgressEmit = now;
    this.bus.publish('playback.progress', this._payload(session));
  }

  async onStop(raw) {
    const key = this.sessionKey(raw.sessionKey, raw.ratingKey, raw.accountId);
    let session = this.sessions.get(key);
    if (!session) {
      session = await this._buildSession(raw, false);
      if (!session) return;
    } else {
      this._updateProgress(session, raw);
    }
    this.bus.publish('playback.finished', this._payload(session));
    this.bus.publish('playback.progress', this._payload(session));
    this.sessions.delete(key);
  }

  async onScrobble(raw) {
    const meta = raw.metadata || {};
    const type = meta.type || raw.type;
    const payload = {
      accountId: String(raw.accountId || meta.accountID || ''),
      ratingKey: String(meta.ratingKey || raw.ratingKey || ''),
      type,
      title: meta.title,
      grandparentTitle: meta.grandparentTitle,
      grandparentRatingKey: meta.grandparentRatingKey
        ? String(meta.grandparentRatingKey)
        : null,
      parentIndex: meta.parentIndex != null ? Number(meta.parentIndex) : null,
      index: meta.index != null ? Number(meta.index) : null,
      librarySectionID: meta.librarySectionID
        ? String(meta.librarySectionID)
        : null,
    };
    if (type === 'episode') {
      this.bus.publish('episode.watched', payload);
    } else if (type === 'movie') {
      this.bus.publish('movie.watched', payload);
    }
  }

  onLibraryUpdate(raw) {
    this.bus.publish('library.updated', {
      sectionId: raw.sectionId ? String(raw.sectionId) : null,
      ...raw,
    });
  }

  async _buildSession(raw, fetchWatched) {
    const ratingKey = String(raw.ratingKey || raw.metadata?.ratingKey || '');
    if (!ratingKey) return null;

    const accountId = String(
      raw.accountId || raw.Account?.id || raw.metadata?.accountID || '0',
    );
    const sessionKey = String(raw.sessionKey || ratingKey);
    const key = this.sessionKey(sessionKey, ratingKey, accountId);

    let wasWatchedAtStart = null;
    let meta = raw.metadata || null;

    if (fetchWatched && this.plex.isConfigured()) {
      try {
        const fetched = await this.plex.getMetadata(ratingKey);
        if (fetched) {
          meta = { ...meta, ...fetched };
          wasWatchedAtStart = fetched.viewCount > 0;
        }
      } catch (err) {
        this.logger.warn(
          `Failed to read metadata for session ${ratingKey}: ${err.message}`,
        );
        wasWatchedAtStart = null;
      }
    }

    const duration = Number(meta?.duration || raw.duration || 0);
    const viewOffset = Number(raw.viewOffset || meta?.viewOffset || 0);
    const progressPercent =
      duration > 0 ? Math.min(100, (viewOffset / duration) * 100) : 0;

    return {
      key,
      sessionKey,
      accountId,
      ratingKey,
      type: meta?.type || raw.type || null,
      title: meta?.title || raw.title || null,
      grandparentTitle: meta?.grandparentTitle || null,
      grandparentRatingKey: meta?.grandparentRatingKey
        ? String(meta.grandparentRatingKey)
        : null,
      parentIndex: meta?.parentIndex != null ? Number(meta.parentIndex) : null,
      index: meta?.index != null ? Number(meta.index) : null,
      librarySectionID: meta?.librarySectionID
        ? String(meta.librarySectionID)
        : null,
      duration,
      viewOffset,
      progressPercent,
      wasWatchedAtStart,
      lastProgressEmit: 0,
    };
  }

  _updateProgress(session, raw) {
    if (raw.viewOffset != null) session.viewOffset = Number(raw.viewOffset);
    if (raw.duration != null) session.duration = Number(raw.duration);
    if (session.duration > 0) {
      session.progressPercent = Math.min(
        100,
        (session.viewOffset / session.duration) * 100,
      );
    }
  }

  _payload(session) {
    return {
      accountId: session.accountId,
      sessionKey: session.sessionKey,
      ratingKey: session.ratingKey,
      type: session.type,
      title: session.title,
      grandparentTitle: session.grandparentTitle,
      grandparentRatingKey: session.grandparentRatingKey,
      parentIndex: session.parentIndex,
      index: session.index,
      librarySectionID: session.librarySectionID,
      duration: session.duration,
      viewOffset: session.viewOffset,
      progressPercent: session.progressPercent,
      wasWatchedAtStart: session.wasWatchedAtStart,
    };
  }
}
