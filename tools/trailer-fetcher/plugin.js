import { runMigrations } from './lib/migrations.js';
import { TrailerFetcherService } from './lib/service.js';
import { createTrailerAddictClient } from './lib/traileraddict.js';

/** @type {TrailerFetcherService|null} */
let service = null;

export async function activate(ctx) {
  runMigrations(ctx.sql);

  const fetchFn = (url, init) => ctx.fetch(url, init);
  const trailerAddict = createTrailerAddictClient({ fetchFn });

  service = new TrailerFetcherService({
    sql: ctx.sql,
    fs: ctx.fs,
    fetchFn,
    trailerAddict,
    log: ctx.log,
    getSettings: () => ctx.settings.get(),
  });

  const settings = ctx.settings.get();
  const pollMinutes = Math.max(1, Number(settings.pollIntervalMinutes ?? 180));

  ctx.scheduler.every(
    pollMinutes * 60_000,
    () =>
      service?.checkForNewTrailers().catch((err) => {
        ctx.log.error(`Trailer poll failed: ${err.message}`);
      }),
    'trailer-fetcher:poll',
  );

  ctx.scheduler.every(
    60 * 60_000,
    () =>
      service?.cleanupExpiredTrailers().catch((err) => {
        ctx.log.error(`Trailer cleanup failed: ${err.message}`);
      }),
    'trailer-fetcher:cleanup',
  );

  service.checkForNewTrailers().catch((err) => {
    ctx.log.error(`Trailer boot poll failed: ${err.message}`);
  });
  service.cleanupExpiredTrailers().catch((err) => {
    ctx.log.error(`Trailer boot cleanup failed: ${err.message}`);
  });

  ctx.log.info('Trailer Fetcher activated');
}

export async function deactivate(ctx) {
  service = null;
  ctx.log.info('Trailer Fetcher deactivated');
}
