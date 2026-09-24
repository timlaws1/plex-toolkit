import { resolveActiveSchedule } from './schedule.js';
import {
  selectFromBucket,
  combinationKey,
  playbackSessionKey,
} from './selection.js';
import { absoluteItemPath, isBrowserPreviewable, contentTypeFor } from './media.js';
import {
  toPlexPath,
  buildPlexPrerollValue,
  isPathUnderRoots,
} from './paths.js';

export const CINEMA_PREROLL_PREF = 'CinemaTrailersPrerollID';

/**
 * Preroll orchestration via plugin ctx (sql.preroll, fs.read, plex.prefs).
 */
export class PrerollService {
  /**
   * @param {{ sql: object, fs: object, plex: object, log: object, getSettings: () => object }} opts
   */
  constructor({ sql, fs, plex, log, getSettings }) {
    this.sql = sql;
    this.fs = fs;
    this.plex = plex;
    this.logger = log;
    this.getSettings = getSettings || (() => ({}));
    /** @type {Set<string>} */
    this._handledSessions = new Set();
    this._generating = false;
  }

  start() {
    this.ensureStateRow();
    this.checkScheduleAndMaybeGenerate({ reason: 'boot' }).catch((err) => {
      this.logger.error(`Preroll boot generate failed: ${err.message}`);
    });
  }

  stop() {
    this._handledSessions.clear();
  }

  ensureStateRow() {
    const row = this.sql.prepare('SELECT id FROM preroll_state WHERE id = 1').get();
    if (!row) {
      this.sql
        .prepare(
          'INSERT INTO preroll_state (id, schedule_id, generated_at, plex_value, items_json, warning, active_schedule_id) VALUES (1, NULL, NULL, NULL, NULL, NULL, NULL)',
        )
        .run();
    }
  }

  getPathPrefixes() {
    const s = this.getSettings() || {};
    return {
      toolkitPrefix: s.toolkitPrefix?.trim() || null,
      plexPrefix: s.plexPrefix?.trim() || null,
    };
  }

  // --- Buckets ---

  listBuckets() {
    return this.sql
      .prepare(
        `SELECT b.*,
          (SELECT COUNT(*) FROM preroll_items i WHERE i.bucket_id = b.id AND i.missing = 0) AS video_count
         FROM preroll_buckets b
         ORDER BY b.name COLLATE NOCASE`,
      )
      .all();
  }

  getBucket(id) {
    return this.sql.prepare('SELECT * FROM preroll_buckets WHERE id = ?').get(id);
  }

  listItems(bucketId) {
    return this.sql
      .prepare(
        `SELECT * FROM preroll_items WHERE bucket_id = ? ORDER BY filename COLLATE NOCASE`,
      )
      .all(bucketId);
  }

  createBucket({ name, description, folderPath, enabled = true }) {
    const info = this.sql
      .prepare(
        `INSERT INTO preroll_buckets (name, description, folder_path, enabled)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        String(name).trim(),
        description?.trim() || null,
        String(folderPath).trim(),
        enabled ? 1 : 0,
      );
    const id = Number(info.lastInsertRowid);
    this.scanBucket(id);
    return this.getBucket(id);
  }

  updateBucket(id, { name, description, folderPath, enabled }) {
    const existing = this.getBucket(id);
    if (!existing) throw new Error('Bucket not found');
    this.sql
      .prepare(
        `UPDATE preroll_buckets
         SET name = ?, description = ?, folder_path = ?, enabled = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        name != null ? String(name).trim() : existing.name,
        description !== undefined
          ? description?.trim() || null
          : existing.description,
        folderPath != null ? String(folderPath).trim() : existing.folder_path,
        enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
        id,
      );
    if (folderPath != null && folderPath !== existing.folder_path) {
      this.scanBucket(id);
    }
    return this.getBucket(id);
  }

  deleteBucket(id) {
    this.sql.prepare('DELETE FROM preroll_buckets WHERE id = ?').run(id);
  }

  setItemEnabled(itemId, enabled) {
    this.sql
      .prepare(
        `UPDATE preroll_items SET enabled = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(enabled ? 1 : 0, itemId);
  }

  scanBucket(bucketId) {
    const bucket = this.getBucket(bucketId);
    if (!bucket) throw new Error('Bucket not found');
    const { entries: found, error: scanError } = this.fs.listVideos(
      bucket.folder_path,
    );
    this.sql
      .prepare(
        `UPDATE preroll_buckets SET scan_error = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(scanError ? JSON.stringify(scanError) : null, bucketId);
    if (scanError) {
      this.logger.warn(
        `Bucket scan failed for ${bucket.folder_path}: ${scanError.code} ${scanError.message} (${scanError.path})`,
      );
    }
    const foundMap = new Map(found.map((f) => [f.relativePath, f]));

    const existing = this.listItems(bucketId);
    const existingMap = new Map(existing.map((i) => [i.relative_path, i]));

    const upsert = this.sql.prepare(
      `INSERT INTO preroll_items
        (bucket_id, filename, relative_path, size_bytes, mtime_ms, duration_ms, enabled, missing, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, datetime('now'))
       ON CONFLICT(bucket_id, relative_path) DO UPDATE SET
         filename = excluded.filename,
         size_bytes = excluded.size_bytes,
         mtime_ms = excluded.mtime_ms,
         duration_ms = excluded.duration_ms,
         missing = 0,
         updated_at = datetime('now')`,
    );
    const markMissing = this.sql.prepare(
      `UPDATE preroll_items SET missing = 1, updated_at = datetime('now') WHERE id = ?`,
    );

    const tx = this.sql.transaction(() => {
      for (const f of found) {
        upsert.run(
          bucketId,
          f.filename,
          f.relativePath,
          f.sizeBytes,
          f.mtimeMs,
          f.durationMs,
        );
      }
      for (const item of existing) {
        if (!foundMap.has(item.relative_path)) {
          markMissing.run(item.id);
        }
      }
    });
    tx();

    // Preserve enabled flags for known files (upsert doesn't touch enabled on conflict)
    void existingMap;
    return this.listItems(bucketId);
  }

  // --- Schedules ---

  listSchedules() {
    return this.sql
      .prepare(
        `SELECT * FROM preroll_schedules ORDER BY
           CASE WHEN start_date IS NULL AND end_date IS NULL THEN 1 ELSE 0 END,
           CASE WHEN start_date IS NULL THEN 1 ELSE 0 END,
           start_date ASC,
           name COLLATE NOCASE`,
      )
      .all();
  }

  getSchedule(id) {
    return this.sql
      .prepare('SELECT * FROM preroll_schedules WHERE id = ?')
      .get(id);
  }

  listSteps(scheduleId) {
    return this.sql
      .prepare(
        `SELECT s.*, b.name AS bucket_name
         FROM preroll_steps s
         LEFT JOIN preroll_buckets b ON b.id = s.bucket_id
         WHERE s.schedule_id = ?
         ORDER BY s.position ASC`,
      )
      .all(scheduleId);
  }

  createSchedule(data) {
    const info = this.sql
      .prepare(
        `INSERT INTO preroll_schedules
          (name, start_date, end_date, start_time, end_time, enabled, selection_mode, repeat_yearly)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(data.name).trim(),
        emptyToNull(data.startDate),
        emptyToNull(data.endDate),
        emptyToNull(data.startTime),
        emptyToNull(data.endTime),
        data.enabled === false || data.enabled === 0 ? 0 : 1,
        data.selectionMode === 'random_avoid_repeats'
          ? 'random_avoid_repeats'
          : 'random',
        data.repeatYearly ? 1 : 0,
      );
    const id = Number(info.lastInsertRowid);
    this.replaceSteps(id, data.steps || []);
    return this.getSchedule(id);
  }

  updateSchedule(id, data) {
    const existing = this.getSchedule(id);
    if (!existing) throw new Error('Schedule not found');
    this.sql
      .prepare(
        `UPDATE preroll_schedules SET
           name = ?,
           start_date = ?,
           end_date = ?,
           start_time = ?,
           end_time = ?,
           enabled = ?,
           selection_mode = ?,
           repeat_yearly = ?,
           updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        data.name != null ? String(data.name).trim() : existing.name,
        data.startDate !== undefined
          ? emptyToNull(data.startDate)
          : existing.start_date,
        data.endDate !== undefined
          ? emptyToNull(data.endDate)
          : existing.end_date,
        data.startTime !== undefined
          ? emptyToNull(data.startTime)
          : existing.start_time,
        data.endTime !== undefined
          ? emptyToNull(data.endTime)
          : existing.end_time,
        data.enabled !== undefined
          ? data.enabled
            ? 1
            : 0
          : existing.enabled,
        data.selectionMode != null
          ? data.selectionMode === 'random_avoid_repeats'
            ? 'random_avoid_repeats'
            : 'random'
          : existing.selection_mode,
        data.repeatYearly !== undefined
          ? data.repeatYearly
            ? 1
            : 0
          : existing.repeat_yearly,
        id,
      );
    if (data.steps) this.replaceSteps(id, data.steps);
    return this.getSchedule(id);
  }

  replaceSteps(scheduleId, steps) {
    const del = this.sql.prepare(
      'DELETE FROM preroll_steps WHERE schedule_id = ?',
    );
    const ins = this.sql.prepare(
      `INSERT INTO preroll_steps (schedule_id, position, bucket_id, count)
       VALUES (?, ?, ?, ?)`,
    );
    const tx = this.sql.transaction(() => {
      del.run(scheduleId);
      (steps || []).forEach((step, i) => {
        const count = Math.max(1, Number(step.count) || 1);
        ins.run(scheduleId, i, Number(step.bucketId), count);
      });
    });
    tx();
  }

  deleteSchedule(id) {
    this.sql.prepare('DELETE FROM preroll_schedules WHERE id = ?').run(id);
  }

  getActiveSchedule(now = new Date()) {
    return resolveActiveSchedule(this.listSchedules(), now);
  }

  getState() {
    this.ensureStateRow();
    const row = this.sql.prepare('SELECT * FROM preroll_state WHERE id = 1').get();
    let items = [];
    try {
      items = row?.items_json ? JSON.parse(row.items_json) : [];
    } catch {
      items = [];
    }
    return { ...row, items };
  }

  /**
   * Check active schedule; regenerate when it changes or state is empty.
   */
  async checkScheduleAndMaybeGenerate({ reason = 'tick', force = false } = {}) {
    const active = this.getActiveSchedule();
    const state = this.getState();
    const activeId = active?.id ?? null;
    const prevActive = state.active_schedule_id ?? null;

    if (activeId !== prevActive) {
      this.logger.info(
        `Preroll active schedule changed: ${scheduleLabel(prevActive, this)} → ${scheduleLabel(activeId, this)}`,
        { reason },
      );
      this.sql
        .prepare(
          `UPDATE preroll_state SET active_schedule_id = ? WHERE id = 1`,
        )
        .run(activeId);
    }

    const needsGenerate =
      force ||
      activeId !== prevActive ||
      !state.plex_value ||
      !state.generated_at;

    if (!active) {
      if (reason !== 'tick') {
        this.logger.warn('Preroll: no active schedule');
      }
      return { generated: false, reason: 'no_schedule' };
    }

    if (!needsGenerate) return { generated: false, reason: 'unchanged' };

    return this.generateAndApply({
      reason: activeId !== prevActive ? 'schedule_change' : reason,
      excludePrevious: false,
    });
  }

  /**
   * @param {{ reason?: string, excludePrevious?: boolean }} opts
   */
  async generateAndApply({ reason = 'manual', excludePrevious = false } = {}) {
    if (this._generating) {
      return { generated: false, reason: 'busy' };
    }
    this._generating = true;
    try {
      const active = this.getActiveSchedule();
      if (!active) {
        this._setWarning('No active schedule');
        return { generated: false, reason: 'no_schedule' };
      }

      const steps = this.listSteps(active.id);
      if (steps.length === 0) {
        this._setWarning(`Schedule “${active.name}” has no steps`);
        this.logger.warn(`Preroll: schedule ${active.id} has no steps`);
        return { generated: false, reason: 'no_steps' };
      }

      const prefixes = this.getPathPrefixes();
      const previous = this.getState();
      const prevIds = excludePrevious
        ? new Set((previous.items || []).map((i) => i.id))
        : new Set();

      const selected = [];
      const stepWarnings = [];
      const mode = active.selection_mode || 'random';

      for (const step of steps) {
        const bucket = this.getBucket(step.bucket_id);
        if (!bucket || !bucket.enabled) {
          const msg = `Step skipped: bucket ${step.bucket_id} missing or disabled`;
          stepWarnings.push(msg);
          this.logger.warn(msg);
          continue;
        }
        const items = this.listItems(bucket.id).filter((i) => !i.missing);
        const usedRows = this.sql
          .prepare('SELECT item_id FROM preroll_history WHERE bucket_id = ?')
          .all(bucket.id);
        const usedIds = usedRows.map((r) => r.item_id);

        const result = selectFromBucket(
          items,
          step.count,
          mode,
          usedIds,
          {
            excludeIds:
              excludePrevious && prevIds.size > 0 ? prevIds : undefined,
          },
        );
        for (const w of result.warnings) {
          stepWarnings.push(`${bucket.name}: ${w}`);
          this.logger.warn(`Preroll selection: ${bucket.name}: ${w}`);
        }

        // Persist avoid-repeats history for this bucket
        if (mode === 'random_avoid_repeats') {
          this._setBucketHistory(bucket.id, result.nextUsedIds);
        }

        for (const item of result.selected) {
          const abs = absoluteItemPath(bucket.folder_path, item.relative_path);
          selected.push({
            id: item.id,
            bucketId: bucket.id,
            bucketName: bucket.name,
            filename: item.filename,
            relativePath: item.relative_path,
            absolutePath: abs,
            plexPath: toPlexPath(abs, prefixes),
            durationMs: item.duration_ms,
            previewable: isBrowserPreviewable(item.filename),
          });
        }
      }

      if (selected.length === 0) {
        const warning =
          stepWarnings.join('; ') ||
          'Could not build a preroll from the active schedule';
        this._setWarning(warning);
        this.logger.warn(`Preroll generate failed (${reason}): ${warning}`);
        return { generated: false, reason: 'empty', warning };
      }

      const plexValue = buildPlexPrerollValue(selected.map((s) => s.plexPath));
      this.logger.info(
        `Preroll generated (${reason}): ${selected.map((s) => s.filename).join(' → ')}`,
      );

      if (!this.plex.isConfigured()) {
        this._saveState({
          scheduleId: active.id,
          plexValue,
          items: selected,
          warning:
            'Plex is not connected — preroll saved locally but not applied',
        });
        this.logger.warn('Preroll: Plex not configured; skipped preference update');
        return { generated: true, applied: false, items: selected };
      }

      try {
        await this.plex.setPreference(CINEMA_PREROLL_PREF, plexValue);
        this.logger.info(`Preroll updated Plex CinemaTrailersPrerollID`);
        this._saveState({
          scheduleId: active.id,
          plexValue,
          items: selected,
          warning: stepWarnings.length ? stepWarnings.join('; ') : null,
        });
        return { generated: true, applied: true, items: selected };
      } catch (err) {
        this.logger.error(`Preroll Plex update failed: ${err.message}`);
        // Keep previous valid Plex value — only store local state with warning
        this._setWarning(`Failed to update Plex: ${err.message}`);
        // Still update local next-preroll display so Roll Again / Overview stay useful
        this._saveState({
          scheduleId: active.id,
          plexValue: previous.plex_value,
          items: selected,
          warning: `Selected next preroll but Plex update failed: ${err.message}`,
          keepPlexValue: true,
        });
        return { generated: true, applied: false, error: err.message };
      }
    } finally {
      this._generating = false;
    }
  }

  async rollAgain() {
    return this.generateAndApply({ reason: 'roll_again', excludePrevious: true });
  }

  /**
   * Handle playback.started — regenerate once per movie session.
   * @param {object} payload
   */
  async onPlaybackStarted(payload) {
    if (!payload || payload.type !== 'movie') return;
    const key = playbackSessionKey(payload);
    if (this._handledSessions.has(key)) return;
    this._handledSessions.add(key);
    // Bound memory
    if (this._handledSessions.size > 500) {
      const first = this._handledSessions.values().next().value;
      this._handledSessions.delete(first);
    }
    this.logger.info(
      `Preroll regenerating after movie start: ${payload.title || payload.ratingKey}`,
    );
    try {
      await this.generateAndApply({ reason: 'playback' });
    } catch (err) {
      this._handledSessions.delete(key);
      this.logger.error(`Preroll playback regenerate failed: ${err.message}`);
    }
  }

  /**
   * Resolve a registered item for authenticated preview streaming.
   * @param {number} itemId
   */
  resolvePreviewItem(itemId) {
    const item = this.sql
      .prepare(
        `SELECT i.*, b.folder_path, b.id AS bucket_id
         FROM preroll_items i
         JOIN preroll_buckets b ON b.id = i.bucket_id
         WHERE i.id = ?`,
      )
      .get(itemId);
    if (!item || item.missing) return null;
    const abs = absoluteItemPath(item.folder_path, item.relative_path);
    const roots = this.listBuckets().map((b) => b.folder_path);
    if (!isPathUnderRoots(abs, roots)) return null;
    return {
      ...item,
      absolutePath: abs,
      previewable: isBrowserPreviewable(item.filename),
      contentType: contentTypeFor(item.filename),
    };
  }

  _setBucketHistory(bucketId, itemIds) {
    const del = this.sql.prepare(
      'DELETE FROM preroll_history WHERE bucket_id = ?',
    );
    const ins = this.sql.prepare(
      `INSERT INTO preroll_history (bucket_id, item_id) VALUES (?, ?)`,
    );
    const tx = this.sql.transaction(() => {
      del.run(bucketId);
      for (const id of itemIds) {
        ins.run(bucketId, id);
      }
    });
    tx();
  }

  _saveState({ scheduleId, plexValue, items, warning, keepPlexValue }) {
    const value = keepPlexValue
      ? this.getState().plex_value
      : plexValue;
    this.sql
      .prepare(
        `UPDATE preroll_state SET
           schedule_id = ?,
           generated_at = datetime('now'),
           plex_value = ?,
           items_json = ?,
           warning = ?,
           active_schedule_id = ?
         WHERE id = 1`,
      )
      .run(
        scheduleId,
        value,
        JSON.stringify(items || []),
        warning || null,
        scheduleId,
      );
  }

  _setWarning(warning) {
    this.ensureStateRow();
    this.sql
      .prepare(`UPDATE preroll_state SET warning = ? WHERE id = 1`)
      .run(warning);
  }
}

function emptyToNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function scheduleLabel(id, service) {
  if (id == null) return '(none)';
  const s = service.getSchedule(id);
  return s ? `${s.name} (#${id})` : `#${id}`;
}

export { combinationKey, playbackSessionKey };
