import crypto from 'node:crypto';
import express from 'express';
import Busboy from 'busboy';

export const WEBHOOK_BODY_LIMIT = 1024 * 1024;

class WebhookBodyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function webhookTokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function isPlexNotification(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (typeof payload.event === 'string' && payload.event) return true;
  const container = payload.NotificationContainer;
  return Boolean(container && typeof container === 'object' && !Array.isArray(container));
}

function parseMultipart(req, limit) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { fields: 20, fieldSize: limit, files: 5, fileSize: limit },
      });
    } catch (err) {
      reject(new WebhookBodyError(400, err.message));
      return;
    }
    const fields = {};
    let total = 0;
    let failed = false;
    const fail = (status, message) => {
      if (failed) return;
      failed = true;
      req.unpipe(bb);
      reject(new WebhookBodyError(status, message));
    };
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) fail(413, 'Webhook body is too large');
    });
    bb.on('field', (name, value, info) => {
      if (info?.valueTruncated) {
        fail(413, 'Webhook field is too large');
        return;
      }
      fields[name] = value;
    });
    bb.on('file', (_name, stream) => stream.resume());
    bb.on('error', (err) => fail(400, err.message));
    bb.on('close', () => {
      if (!failed) resolve(fields);
    });
    req.pipe(bb);
  });
}

/**
 * Mount the Plex webhook. Must be registered before the app-wide body parsers so a
 * request with a wrong token is answered without reading its body.
 * @param {import('express').Express} app
 * @param {{ token: string, eventMonitor: { handleWebhook(payload: object): unknown }, logger: any, limit?: number }} opts
 */
export function mountPlexWebhook(app, { token, eventMonitor, logger, limit = WEBHOOK_BODY_LIMIT }) {
  app.post('/webhooks/plex', (req, res) => {
    res.status(404).end();
  });

  app.post(
    '/webhooks/plex/:token',
    (req, res, next) => {
      if (!webhookTokenMatches(req.params.token, token)) {
        res.status(404).end();
        return;
      }
      next();
    },
    express.json({ limit }),
    express.urlencoded({ extended: false, limit }),
    async (req, res, next) => {
      try {
        if (req.is('multipart/form-data')) {
          req.body = await parseMultipart(req, limit);
        }
        let payload = req.body;
        if (payload && typeof payload.payload === 'string') {
          try {
            payload = JSON.parse(payload.payload);
          } catch {
            throw new WebhookBodyError(400, 'Webhook payload is not valid JSON');
          }
        }
        if (!isPlexNotification(payload)) {
          throw new WebhookBodyError(400, 'Not a Plex notification');
        }
        eventMonitor.handleWebhook(payload);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
    (err, req, res, _next) => {
      const status = Number(err?.status) >= 400 && Number(err.status) < 500 ? Number(err.status) : 400;
      logger.warn(`Webhook rejected (${status}): ${err.message}`);
      if (status === 413) res.set('Connection', 'close');
      res.status(status).json({ error: status === 413 ? 'Webhook body is too large' : 'Invalid webhook body' });
    },
  );
}
