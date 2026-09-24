import { PrerollService } from './lib/service.js';
import {
  renderOverview,
  renderBuckets,
  renderSchedules,
  parseStepsFromBody,
} from './lib/ui.js';
import { contentTypeFor } from './lib/media.js';

const APP = '/plugins/preroll-scheduler/app';

/** @type {PrerollService|null} */
let service = null;

export async function activate(ctx) {
  service = new PrerollService({
    sql: ctx.sql,
    fs: ctx.fs,
    plex: ctx.plex,
    log: ctx.log,
    getSettings: () => ctx.settings.get(),
  });

  ctx.events.on('playback.started', (payload) => {
    service?.onPlaybackStarted(payload).catch((err) => {
      ctx.log.error(`Playback handler failed: ${err.message}`);
    });
  });

  ctx.scheduler.every(
    60_000,
    () =>
      service?.checkScheduleAndMaybeGenerate({ reason: 'tick' }).catch((err) => {
        ctx.log.error(`Schedule tick failed: ${err.message}`);
      }),
    'preroll-schedule',
  );

  service.start();
  ctx.log.info('Preroll Scheduler activated');
}

export async function deactivate(ctx) {
  service?.stop();
  service = null;
  ctx.log.info('Preroll Scheduler deactivated');
}

export async function handleRequest(ctx, req) {
  if (!service) {
    return {
      title: 'Preroll',
      body: '<p class="muted">Tool is not active. Enable it from the Tools page.</p>',
    };
  }

  const query = req.query || {};
  const mediaId = query.media;
  if (mediaId) {
    const item = service.resolvePreviewItem(Number(mediaId));
    if (!item) {
      return { status: 404, body: 'Not found' };
    }
    let size;
    try {
      size = ctx.fs.stat(item.absolutePath).size;
    } catch {
      return { status: 404, body: 'File missing' };
    }
    return {
      file: item.absolutePath,
      contentType: item.contentType || contentTypeFor(item.filename),
      size,
    };
  }

  if (req.method === 'POST') {
    return handlePost(ctx, req, query);
  }

  return handleGet(service, query);
}

async function handlePost(ctx, req, query) {
  const action = String(req.body?.action || query.action || '');

  try {
    if (action === 'roll') {
      const result = await service.rollAgain();
      if (result.generated) {
        return { redirect: `${APP}?tab=overview`, flash: 'ok', message: 'Next preroll rolled' };
      }
      return {
        redirect: `${APP}?tab=overview`,
        flash: 'error',
        message: result.warning || 'Could not generate a preroll',
      };
    }

    if (action === 'bucket_create') {
      const bucket = service.createBucket({
        name: req.body.name,
        description: req.body.description,
        folderPath: req.body.folder_path,
        enabled: req.body.enabled === '1',
      });
      return {
        redirect: `${APP}?tab=buckets&bucket=${bucket.id}`,
        flash: 'ok',
        message: `Bucket “${bucket.name}” created`,
      };
    }

    if (action === 'bucket_update') {
      const id = Number(req.body.id);
      service.updateBucket(id, {
        name: req.body.name,
        description: req.body.description,
        folderPath: req.body.folder_path,
        enabled: req.body.enabled === '1',
      });
      return {
        redirect: `${APP}?tab=buckets&bucket=${id}`,
        flash: 'ok',
        message: 'Bucket saved',
      };
    }

    if (action === 'bucket_delete') {
      service.deleteBucket(Number(req.body.id));
      return { redirect: `${APP}?tab=buckets`, flash: 'ok', message: 'Bucket deleted' };
    }

    if (action === 'bucket_rescan') {
      const id = Number(req.body.id);
      const items = service.scanBucket(id);
      const bucket = service.getBucket(id);
      if (bucket?.scan_error) {
        let detail = 'Scan failed';
        try {
          const err = JSON.parse(bucket.scan_error);
          detail = err.message || detail;
        } catch {
          // ignore
        }
        return {
          redirect: `${APP}?tab=buckets&bucket=${id}`,
          flash: 'error',
          message: detail,
        };
      }
      return {
        redirect: `${APP}?tab=buckets&bucket=${id}`,
        flash: 'ok',
        message: `Found ${items.filter((i) => !i.missing).length} videos`,
      };
    }

    if (action === 'item_toggle') {
      const id = Number(req.body.id);
      const enabled = req.body.enabled === '1';
      service.setItemEnabled(id, enabled);
      const item = ctx.sql
        .prepare('SELECT bucket_id FROM preroll_items WHERE id = ?')
        .get(id);
      return {
        redirect: item
          ? `${APP}?tab=buckets&bucket=${item.bucket_id}`
          : `${APP}?tab=buckets`,
        flash: 'ok',
        message: enabled ? 'Video enabled' : 'Video disabled',
      };
    }

    if (action === 'schedule_create') {
      const schedule = service.createSchedule({
        name: req.body.name,
        startDate: req.body.start_date,
        endDate: req.body.end_date,
        startTime: req.body.start_time,
        endTime: req.body.end_time,
        enabled: req.body.enabled === '1',
        selectionMode: req.body.selection_mode,
        repeatYearly: req.body.repeat_yearly === '1',
        steps: parseStepsFromBody(req.body),
      });
      await service.checkScheduleAndMaybeGenerate({
        reason: 'schedule_save',
        force: true,
      });
      return {
        redirect: `${APP}?tab=schedules`,
        flash: 'ok',
        message: `Schedule “${schedule.name}” created`,
      };
    }

    if (action === 'schedule_update') {
      const id = Number(req.body.id);
      service.updateSchedule(id, {
        name: req.body.name,
        startDate: req.body.start_date,
        endDate: req.body.end_date,
        startTime: req.body.start_time,
        endTime: req.body.end_time,
        enabled: req.body.enabled === '1',
        selectionMode: req.body.selection_mode,
        repeatYearly: req.body.repeat_yearly === '1',
        steps: parseStepsFromBody(req.body),
      });
      await service.checkScheduleAndMaybeGenerate({
        reason: 'schedule_save',
        force: true,
      });
      return { redirect: `${APP}?tab=schedules`, flash: 'ok', message: 'Schedule saved' };
    }

    if (action === 'schedule_delete') {
      service.deleteSchedule(Number(req.body.id));
      await service.checkScheduleAndMaybeGenerate({
        reason: 'schedule_delete',
        force: true,
      });
      return { redirect: `${APP}?tab=schedules`, flash: 'ok', message: 'Schedule deleted' };
    }
  } catch (err) {
    return {
      redirect: `${APP}?tab=${req.body?.tab || 'overview'}`,
      flash: 'error',
      message: err.message,
    };
  }

  return {
    redirect: `${APP}?tab=overview`,
    flash: 'error',
    message: 'Unknown action',
  };
}

function handleGet(svc, query) {
  const tab = String(query.tab || 'overview');
  const buckets = svc.listBuckets();
  const schedules = svc.listSchedules();
  const settings = svc.getPathPrefixes();

  if (tab === 'buckets') {
    const editId = query.edit ? Number(query.edit) : null;
    const openId = query.bucket ? Number(query.bucket) : null;
    const editing = editId ? svc.getBucket(editId) : null;
    const openBucket = openId ? svc.getBucket(openId) : null;
    return {
      title: 'Preroll',
      body: renderBuckets({
        buckets,
        editing,
        items: editing ? svc.listItems(editing.id) : null,
        showNew: query.new === '1' || query.new === 'true',
        openBucket,
        openItems: openBucket ? svc.listItems(openBucket.id) : null,
        basePath: APP,
      }),
    };
  }

  if (tab === 'schedules') {
    const editId = query.edit ? Number(query.edit) : null;
    const editing = editId ? svc.getSchedule(editId) : null;
    return {
      title: 'Preroll',
      body: renderSchedules({
        schedules,
        buckets,
        editing,
        steps: editing ? svc.listSteps(editing.id) : [],
        showNew: query.new === '1' || query.new === 'true',
        pathPrefixes: settings,
        basePath: APP,
      }),
    };
  }

  const activeSchedule = svc.getActiveSchedule();
  const state = svc.getState();
  const steps = activeSchedule ? svc.listSteps(activeSchedule.id) : [];
  return {
    title: 'Preroll',
    body: renderOverview({
      buckets,
      schedules,
      activeSchedule,
      state,
      steps,
      basePath: APP,
    }),
  };
}
