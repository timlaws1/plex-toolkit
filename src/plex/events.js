import WebSocket from 'ws';
import { SessionTracker } from './sessions.js';

export class PlexEventMonitor {
  constructor({ plex, bus, logger }) {
    this.plex = plex;
    this.bus = bus;
    this.logger = logger;
    this.tracker = new SessionTracker({ plex, bus, logger });
    this.ws = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  restart() {
    this.stop();
    this.stopped = false;
    this.reconnectAttempt = 0;
    this._connect();
  }

  handleWebhook(payload) {
    const event = payload?.event || payload?.NotificationContainer?.type;
    const metadata =
      payload?.Metadata ||
      payload?.metadata ||
      payload?.NotificationContainer?.TimelineEntry?.[0] ||
      null;
    const accountId =
      payload?.Account?.id ||
      payload?.account?.id ||
      metadata?.accountID ||
      null;

    if (event === 'media.play' || event === 'media.resume') {
      this.tracker.onPlay({
        ratingKey: metadata?.ratingKey,
        sessionKey: payload?.Player?.local || metadata?.ratingKey,
        accountId,
        viewOffset: metadata?.viewOffset,
        duration: metadata?.duration,
        type: metadata?.type,
        metadata,
      });
      return;
    }
    if (event === 'media.pause' || event === 'media.progress') {
      this.tracker.onProgress({
        ratingKey: metadata?.ratingKey,
        sessionKey: payload?.Player?.local || metadata?.ratingKey,
        accountId,
        viewOffset: metadata?.viewOffset,
        duration: metadata?.duration,
        type: metadata?.type,
        metadata,
      });
      return;
    }
    if (event === 'media.stop') {
      this.tracker.onStop({
        ratingKey: metadata?.ratingKey,
        sessionKey: payload?.Player?.local || metadata?.ratingKey,
        accountId,
        viewOffset: metadata?.viewOffset,
        duration: metadata?.duration,
        type: metadata?.type,
        metadata,
      });
      return;
    }
    if (event === 'media.scrobble') {
      this.tracker.onScrobble({
        accountId,
        metadata,
        type: metadata?.type,
        ratingKey: metadata?.ratingKey,
      });
      return;
    }
    if (event === 'library.new' || event === 'library.on.deck') {
      this.tracker.onLibraryUpdate({
        sectionId: metadata?.librarySectionID,
        event,
      });
    }
  }

  _connect() {
    if (this.stopped) return;
    if (!this.plex.isConfigured()) {
      this.logger.info('Plex websocket idle: not configured');
      return;
    }
    const url = this.plex.websocketUrl();
    if (!url) return;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.logger.error(`Plex websocket create failed: ${err.message}`);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.logger.info('Plex websocket connected');
    });

    this.ws.on('message', (data) => {
      try {
        const text = data.toString();
        const msg = JSON.parse(text);
        this._handleWsMessage(msg);
      } catch (err) {
        this.logger.debug(`Bad websocket message: ${err.message}`);
      }
    });

    this.ws.on('close', () => {
      this.logger.warn('Plex websocket closed');
      this.ws = null;
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.logger.warn(`Plex websocket error: ${err.message}`);
    });
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(60_000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.logger.info(`Reconnecting Plex websocket in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _handleWsMessage(msg) {
    const container = msg?.NotificationContainer || msg;
    const type = container?.type;
    if (type === 'playing') {
      const entries = container.PlaySessionStateNotification || [];
      for (const entry of entries) {
        this._handlePlaying(entry);
      }
      return;
    }
    if (type === 'activity') {
      const entries = container.ActivityNotification || [];
      for (const entry of entries) {
        if (entry?.event === 'ended' && entry?.Activity?.type === 'library.update.item') {
          this.tracker.onLibraryUpdate({
            sectionId: entry.Activity?.Context?.librarySectionID,
          });
        }
      }
    }
  }

  _handlePlaying(entry) {
    const state = entry.state;
    const raw = {
      sessionKey: entry.sessionKey,
      ratingKey: entry.ratingKey,
      accountId: entry.accountID,
      viewOffset: entry.viewOffset,
      // duration not always present on playing notifications
      key: entry.key,
    };
    if (state === 'playing') {
      // first time we see this session => play, else progress
      const key = this.tracker.sessionKey(
        entry.sessionKey,
        entry.ratingKey,
        entry.accountID,
      );
      if (!this.tracker.sessions.has(key)) {
        this.tracker.onPlay(raw);
      } else {
        this.tracker.onProgress(raw);
      }
    } else if (state === 'paused' || state === 'buffering') {
      this.tracker.onProgress(raw);
    } else if (state === 'stopped') {
      this.tracker.onStop(raw);
    }
  }
}
