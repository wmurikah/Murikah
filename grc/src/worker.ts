import astro from '@astrojs/cloudflare/entrypoints/server';
import { getGrcEnv } from './lib/grc/env';
import { getDb as getGrcDb } from './lib/grc/db';
import { updateOverdueStatuses } from './lib/grc/repos/overdue';
import { getGrcDeliveryEnv } from './lib/grc/notify/env';
import { runGrcDispatch } from './lib/grc/notify/dispatch';
import {
  runStaleReminders,
  runOverdueReminders,
  runDueSoonReminders,
} from './lib/grc/notify/reminders';
import { runEvidenceMigration } from './lib/grc/storage/migrate';

import { systemClock } from './lib/shared/time';

const DAILY_PM_CRON = '0 3 * * *';
export default {
 async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/__astro')) return astro.fetch(request, env, ctx);
  const host = (request.headers.get('host') ?? url.host).split(':')[0].toLowerCase();
  if (!(host === 'grc.murikah.com' || host.endsWith('.grc.murikah.com') || host === 'grc.localhost' || host.endsWith('.grc.localhost') || host === 'localhost' || host === '127.0.0.1')) return new Response('Not found', {status:404});
  if (!url.pathname.startsWith('/_') && !/\.[a-z0-9]+$/i.test(url.pathname) && url.pathname !== '/grc' && !url.pathname.startsWith('/grc/')) url.pathname = '/grc' + (url.pathname === '/' ? '' : url.pathname);
  const response = await astro.fetch(new Request(url,request), env, ctx);
  const result = new Response(response.body,response);
  result.headers.set('x-mrk-host',host); result.headers.set('x-mrk-branch','grc-app'); return result;
 },
 async scheduled(controller: ScheduledController, _env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil((async () => {         try {
          const grcEnv = getGrcEnv();
          const grcDb = await getGrcDb(grcEnv);
          await runGrcDispatch(grcDb, getGrcDeliveryEnv(), grcEnv.sessionSecret, systemClock, {
            limit: 200,
          });
          if (controller.cron === DAILY_PM_CRON) {
            await updateOverdueStatuses(grcDb);
            await runStaleReminders(grcDb, systemClock);
            await runDueSoonReminders(grcDb, systemClock);
            await runOverdueReminders(grcDb, systemClock);
            // Migrate a batch of Drive-backed evidence to R2 (skipping legal
            // holds). A no-op until both R2 and the Drive credential are set.
            await runEvidenceMigration(grcDb, 25);
          }
        } catch {
          // best-effort GRC maintenance
        }
 })());
 }
};
