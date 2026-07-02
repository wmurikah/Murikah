/**
 * Worker entry with a scheduled() handler for the Cron Triggers.
 *
 * The fetch handler is the Astro SSR handler from the Cloudflare adapter,
 * re-exported unchanged. scheduled() adds the two crons declared in
 * wrangler.jsonc:
 *   - every five minutes: drain the notification queue (runDispatch),
 *   - 03:00 UTC (06:00 EAT) daily: run the PM scan, then drain.
 *
 * The cron and the per-request nudge are safe to overlap because the dispatcher
 * claims each row atomically. Env for the database and providers is read from
 * the cloudflare:workers module inside getEngrEnv and getDeliveryEnv, so the
 * scheduled context needs no wiring beyond calling them.
 *
 * To wire this handler, wrangler.jsonc sets `main` to this file. If an
 * environment cannot build a custom entry, the same drains are reachable through
 * the secured /engr/api/cron/* endpoints, which the Cron Trigger or an external
 * scheduler can call.
 */
import astro from '@astrojs/cloudflare/entrypoints/server';
import { getEngrEnv } from './lib/engr/env';
import { getDeliveryEnv } from './lib/engr/notify/env';
import { getDb } from './lib/engr/db';
import { runDispatch } from './lib/engr/notify/dispatch';
import { runPmScan } from './lib/engr/workflow/pmScan';
import { systemClock } from './lib/engr/time';

const DAILY_PM_CRON = '0 3 * * *';

export default {
  fetch: astro.fetch,
  async scheduled(
    controller: ScheduledController,
    _env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const db = await getDb(getEngrEnv());
        const delivery = getDeliveryEnv();
        if (controller.cron === DAILY_PM_CRON) {
          await runPmScan(db, delivery, systemClock, { orgLimit: 50, scheduleLimit: 200 });
        }
        await runDispatch(db, delivery, systemClock, { limit: 200 });
      })(),
    );
  },
};
