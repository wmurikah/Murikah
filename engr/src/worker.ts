import astro from '@astrojs/cloudflare/entrypoints/server';
import { getEngrEnv } from './lib/engr/env';
import { getDeliveryEnv } from './lib/engr/notify/env';
import { getDb } from './lib/engr/db';
import { runDispatch } from './lib/engr/notify/dispatch';
import { runPmScan } from './lib/engr/workflow/pmScan';
import { systemClock } from './lib/engr/time';

const DAILY_PM_CRON = '0 3 * * *';
export default {
 async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/__astro')) return astro.fetch(request, env, ctx);
  const host = (request.headers.get('host') ?? url.host).split(':')[0].toLowerCase();
  if (!(host === 'engr.murikah.com' || host.endsWith('.engr.murikah.com') || host === 'engr.localhost' || host.endsWith('.engr.localhost') || host === 'localhost' || host === '127.0.0.1')) return new Response('Not found', {status:404});
  if (!url.pathname.startsWith('/_') && !/\.[a-z0-9]+$/i.test(url.pathname) && url.pathname !== '/engr' && !url.pathname.startsWith('/engr/')) url.pathname = '/engr' + (url.pathname === '/' ? '' : url.pathname);
  const response = await astro.fetch(new Request(url,request), env, ctx);
  const result = new Response(response.body,response);
  result.headers.set('x-mrk-host',host); result.headers.set('x-mrk-branch','app'); return result;
 },
 async scheduled(controller: ScheduledController, _env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil((async () => {         try {
          const db = await getDb(getEngrEnv());
          const delivery = getDeliveryEnv();
          if (controller.cron === DAILY_PM_CRON) {
            await runPmScan(db, delivery, systemClock, { orgLimit: 50, scheduleLimit: 200 });
          }
          await runDispatch(db, delivery, systemClock, { limit: 200 });
        } catch (err) {
          console.error('[engr.cron] scheduled run failed', err);
        }

 })());
 }
};
