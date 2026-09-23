import { runSync } from './lib/sync.js';

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_INTERVAL_HOURS = 12;

export async function activate(ctx) {
  ctx.log.info('Letterboxd Watchlist Sync activated');

  const settings = ctx.settings.get();
  if (settings.enabled !== false) {
    void runScheduledSync(ctx);
    const hours = Math.max(
      1,
      Number(settings.intervalHours) || DEFAULT_INTERVAL_HOURS,
    );
    ctx.scheduler.every(hours * HOUR_MS, () => runScheduledSync(ctx), 'letterboxd-sync');
  }

  const last = ctx.storage.get('lastSync');
  ctx.panels.add({
    title: 'Letterboxd Watchlist',
    empty: 'Set your Letterboxd username in settings to sync into Plex.',
    items: [
      {
        id: 'status',
        title: settings.letterboxdUsername
          ? `@${settings.letterboxdUsername}`
          : 'No username set',
        subtitle: last?.message || 'Not synced yet',
        meta: last?.at ? `Last sync: ${last.at}` : '',
        actions: [
          {
            id: 'sync-now',
            label: 'Sync now',
            confirm: 'Sync Letterboxd watchlist into Plex now?',
          },
        ],
      },
    ],
    actions: {
      async 'sync-now'() {
        const result = await runSync(ctx);
        return { message: result.message };
      },
    },
  });
}

export async function deactivate(ctx) {
  ctx.log.info('Letterboxd Watchlist Sync deactivated');
}

async function runScheduledSync(ctx) {
  const settings = ctx.settings.get();
  if (settings.enabled === false) return;
  if (!String(settings.letterboxdUsername || '').trim()) {
    ctx.log.info('Letterboxd sync skipped: no username configured');
    return;
  }
  try {
    const result = await runSync(ctx);
    ctx.log.info(result.message);
  } catch (err) {
    ctx.log.error(`Letterboxd sync failed: ${err.message}`);
  }
}
