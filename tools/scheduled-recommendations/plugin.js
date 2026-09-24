import { RecommendationsService } from './lib/service.js';
import { scheduleFromBody } from './lib/schedule.js';
import { blankSchedule, renderForm, renderHome } from './lib/ui.js';

const APP = '/plugins/scheduled-recommendations/app';
const HOUR_MS = 60 * 60 * 1000;

/** @type {RecommendationsService|null} */
let service = null;

export async function activate(ctx) {
  service = new RecommendationsService({
    sql: ctx.sql,
    plex: ctx.plex,
    log: ctx.log,
    fetchFn: (url, init) => ctx.fetch(url, init),
    getSettings: () => ctx.settings.get(),
  });

  ctx.events.on('movie.watched', (payload) => {
    service?.onMovieWatched(payload).catch((err) => {
      ctx.log.error(`Watch handler failed: ${err.message}`);
    });
  });

  ctx.scheduler.every(
    60_000,
    () => service?.tick().catch((err) => ctx.log.error(`Schedule tick failed: ${err.message}`)),
    'recommendations-tick',
  );

  const hours = Math.max(1, Number(ctx.settings.get().rssIntervalHours || 6));
  ctx.scheduler.every(
    hours * HOUR_MS,
    () => service?.checkRss().catch((err) => ctx.log.error(`RSS check failed: ${err.message}`)),
    'recommendations-rss',
  );
  service.checkRss().catch((err) => ctx.log.warn(`Letterboxd RSS unavailable: ${err.message}`));
  ctx.log.info('Scheduled Recommendations activated');
}

export async function deactivate() {
  service = null;
}

export async function handleRequest(ctx, req) {
  if (!service) {
    return { title: 'Recommendations', body: '<p class="muted">Enable this tool from the Tools page.</p>' };
  }
  if (req.method === 'POST') return handlePost(ctx, req);
  const query = req.query || {};
  if (query.new || query.edit) {
    const existing = query.edit ? service.store.getSchedule(Number(query.edit)) : null;
    const schedule = existing || blankSchedule(query.preset);
    let libraries = [];
    try {
      if (ctx.plex.isConfigured()) libraries = await ctx.plex.getLibraries();
    } catch (err) {
      ctx.log.warn(`Could not list Plex libraries: ${err.message}`);
    }
    return {
      title: 'Recommendations',
      body: renderForm({ schedule, libraries, preset: query.preset }),
    };
  }
  const schedules = service.store.listSchedules();
  const lastRuns = new Map(schedules.map((schedule) => [schedule.id, service.store.lastRun(schedule.id)]));
  return {
    title: 'Recommendations',
    body: renderHome({
      schedules,
      lastRuns,
      importInfo: service.store.lastImport(),
      filmCount: service.store.filmCount(),
    }),
  };
}

async function handlePost(ctx, req) {
  const body = req.body || {};
  const action = body.action;
  if (action === 'import') {
    const encoded = String(body.zip_base64 || '');
    if (!encoded) throw new Error('Choose a Letterboxd export ZIP');
    const count = await service.importZip(Buffer.from(encoded, 'base64'));
    return { redirect: APP, message: `Imported ${count} films` };
  }
  if (action === 'delete') {
    service.store.deleteSchedule(Number(body.id));
    return { redirect: APP, message: 'Schedule deleted' };
  }
  if (action === 'toggle') {
    const schedule = service.store.getSchedule(Number(body.id));
    if (!schedule) throw new Error('Schedule not found');
    service.store.setEnabled(schedule.id, Number(schedule.enabled) ? 0 : 1);
    return { redirect: APP, message: Number(schedule.enabled) ? 'Schedule disabled' : 'Schedule enabled' };
  }
  if (action === 'run') {
    const picks = await service.runNow(Number(body.id));
    return { redirect: APP, message: `Published ${picks.length} recommendations` };
  }
  if (action === 'save') {
    const fields = scheduleFromBody(body);
    if (!fields.name) throw new Error('Name is required');
    const id = req.query?.edit ? Number(req.query.edit) : null;
    service.store.saveSchedule(fields, id || null);
    return { redirect: APP, message: 'Schedule saved' };
  }
  throw new Error('Unknown action');
}
