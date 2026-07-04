/**
 * Worker entry. Two responsibilities: route by hostname, and run the scheduled
 * cron drains.
 *
 * Host routing lives here, not in Astro middleware, because the Cloudflare
 * adapter answers static assets and the prerendered 404 (matchStaticAsset and
 * fallbackToAssets in the adapter's handler) before any middleware runs. So the
 * branch is decided at the very top of the worker, before the Astro handler sees
 * the request. `run_worker_first` in wrangler.jsonc makes the platform invoke
 * this worker before the assets layer, so it runs for every request.
 *
 * On the engr host the request is rewritten internally to its /engr route so the
 * file under src/pages/engr/** serves at the subdomain root while the browser URL
 * stays clean. The session guard then runs in src/middleware.ts against that
 * /engr route. Every response carries x-mrk-host and x-mrk-branch so the branch
 * is observable with a plain curl on the Cloudflare preview and in production;
 * they can be removed in a later tidy-up.
 *
 * The scheduled() handler runs the two crons declared in wrangler.jsonc:
 *   - every five minutes: drain the notification queue (runDispatch),
 *   - 03:00 UTC (06:00 EAT) daily: run the PM scan, then drain, and refresh the
 *     GRC action-plan overdue statuses.
 *
 * The GRC overdue refresh runs against the GRC database and is wrapped so a
 * missing GRC binding or a schema difference never fails the engr crons; it is a
 * system maintenance job across every organisation, not a tenant request.
 */
import astro from '@astrojs/cloudflare/entrypoints/server';
import { requestHost, routeDecision } from './lib/engr/routing';
import {
  isGrcHost,
  toGrcPath,
  isGrcPassthroughAsset,
  grcMarketingRedirect,
} from './lib/grc/routing';
import { getEngrEnv } from './lib/engr/env';
import { getDeliveryEnv } from './lib/engr/notify/env';
import { getDb } from './lib/engr/db';
import { runDispatch } from './lib/engr/notify/dispatch';
import { runPmScan } from './lib/engr/workflow/pmScan';
import { systemClock } from './lib/engr/time';
import { getGrcEnv } from './lib/grc/env';
import { getDb as getGrcDb } from './lib/grc/db';
import { updateOverdueStatuses } from './lib/grc/repos/overdue';
import { getGrcDeliveryEnv } from './lib/grc/notify/env';
import { runGrcDispatch } from './lib/grc/notify/dispatch';
import { runStaleReminders, runOverdueReminders } from './lib/grc/notify/reminders';

const DAILY_PM_CRON = '0 3 * * *';

// Attach the debug headers, cloning so a response with immutable headers (an
// asset from the ASSETS binding) can still be stamped. The branch label is a
// free string (engr and grc branches), surfaced only for observability.
function stamp(response: Response, host: string, branch: string): Response {
  const out = new Response(response.body, response);
  out.headers.set('x-mrk-host', host);
  out.headers.set('x-mrk-branch', branch);
  return out;
}

function redirect(location: string): Response {
  return new Response(null, { status: 301, headers: { location } });
}

// A neutral, self-contained not-found page for the engr host, so no corporate
// content renders here. Inline styles only: the hashed engr stylesheet cannot be
// referenced from the worker.
const ENGR_NOT_FOUND_HTML = `<!doctype html>
<html lang="en-KE"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Page not found, Engineering Rhythm</title><style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f6f4ee;color:#1b1b1b;display:grid;min-height:100vh;place-items:center;padding:1.5rem}main{max-width:32rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:0 0 1.25rem;color:#565656}a{display:inline-block;min-height:2.75rem;line-height:2.75rem;padding:0 1.1rem;border-radius:.5rem;background:#12233b;color:#f6f4ee;text-decoration:none;font-weight:600}</style></head><body><main><h1>Page not found</h1><p>That page does not exist on Engineering Rhythm. Check the address, or return to the sign-in page.</p><a href="/login">Go to sign in</a></main></body></html>`;

// On the engr host a 404 means the /engr route did not exist. Astro falls back
// to the single root 404 page, which is the corporate one, so replace it. The
// app's own not-found screens render the engr layout (body class "engr"); keep
// those so their specific message survives.
async function engrNotFound(response: Response, host: string): Promise<Response> {
  const body = await response.text();
  if (body.includes('class="engr"')) {
    return stamp(new Response(body, response), host, 'app');
  }
  return stamp(
    new Response(ENGR_NOT_FOUND_HTML, {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
    host,
    'app',
  );
}

// The grc equivalent: a neutral not-found for the grc host, so no corporate
// content renders there. The app's own not-found screens use the grc layout
// (body class "grc"); keep those so their specific message survives.
const GRC_NOT_FOUND_HTML = `<!doctype html>
<html lang="en-KE"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Page not found, Murikah GRC</title><style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f6f4ee;color:#1b1b1b;display:grid;min-height:100vh;place-items:center;padding:1.5rem}main{max-width:32rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:0 0 1.25rem;color:#565656}a{display:inline-block;min-height:2.75rem;line-height:2.75rem;padding:0 1.1rem;border-radius:.5rem;background:#12233b;color:#f6f4ee;text-decoration:none;font-weight:600}</style></head><body><main><h1>Page not found</h1><p>That page does not exist on Murikah GRC. Check the address, or return to the sign-in page.</p><a href="/login">Go to sign in</a></main></body></html>`;

async function grcNotFound(response: Response, host: string): Promise<Response> {
  const body = await response.text();
  if (body.includes('class="grc"')) {
    return stamp(new Response(body, response), host, 'grc-app');
  }
  return stamp(
    new Response(GRC_NOT_FOUND_HTML, {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
    host,
    'grc-app',
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // The adapter's build-time prerender server posts to its internal endpoints
    // (/__astro_static_paths, /__astro_prerender, /__astro_static_images) with a
    // build host that is none of ours. Let those through untouched so the build
    // can prerender; in production they are not real routes and simply 404.
    if (url.pathname.startsWith('/__astro')) {
      return astro.fetch(request, env, ctx);
    }

    const host = requestHost(request);

    // The GRC platform host: serve the grc app, rewriting to the internal /grc
    // route unless the path is already there or is a static asset. The browser
    // URL is unchanged. The session guard then runs in src/middleware.ts against
    // that /grc route.
    if (isGrcHost(host)) {
      const grcPath = isGrcPassthroughAsset(url.pathname) ? url.pathname : toGrcPath(url.pathname);
      let response: Response;
      if (grcPath === url.pathname) {
        response = await astro.fetch(request, env, ctx);
      } else {
        const rewritten = new URL(url);
        rewritten.pathname = grcPath;
        response = await astro.fetch(new Request(rewritten, request), env, ctx);
      }
      if (response.status === 404) return grcNotFound(response, host);
      return stamp(response, host, 'grc-app');
    }

    const decision = routeDecision(host, url.pathname, url.search);

    // On the marketing apex a /grc path is sent to the subdomain, exactly as a
    // /engr path is, so a stray in-app link never renders on the corporate site.
    if (decision.branch === 'marketing') {
      const grcLocation = grcMarketingRedirect(url.pathname, url.search);
      if (grcLocation) return stamp(redirect(grcLocation), host, 'redirect-grc-path');
    }

    switch (decision.branch) {
      case 'redirect-www':
      case 'redirect-engr-path':
        return stamp(redirect(decision.location), host, decision.branch);

      case 'not-found-host':
        // A stray host never sees corporate content: a neutral 404, not a
        // redirect that would surface the marketing site.
        return stamp(
          new Response('Not found', {
            status: 404,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          }),
          host,
          'not-found-host',
        );

      case 'marketing':
        return stamp(await astro.fetch(request, env, ctx), host, 'marketing');

      case 'app': {
        // Rewrite to the /engr route unless the path is already there or is a
        // static asset. The browser URL is unchanged; this is an internal fetch.
        let response: Response;
        if (decision.enginePath === url.pathname) {
          response = await astro.fetch(request, env, ctx);
        } else {
          const rewritten = new URL(url);
          rewritten.pathname = decision.enginePath;
          response = await astro.fetch(new Request(rewritten, request), env, ctx);
        }
        if (response.status === 404) return engrNotFound(response, host);
        return stamp(response, host, 'app');
      }
    }
  },

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

        // GRC maintenance and notification delivery. Wrapped so a missing GRC
        // binding or a schema difference never fails the engr crons. The queue is
        // drained every run (urgent promptly, normal batched into digests); the
        // daily cron also refreshes overdue statuses and sends the stale reminders,
        // and the weekly overdue reminders on Mondays.
        try {
          const grcDb = await getGrcDb(getGrcEnv());
          await runGrcDispatch(grcDb, getGrcDeliveryEnv(), systemClock, { limit: 200 });
          if (controller.cron === DAILY_PM_CRON) {
            await updateOverdueStatuses(grcDb);
            await runStaleReminders(grcDb, systemClock);
            if (systemClock.now().getUTCDay() === 1) {
              await runOverdueReminders(grcDb, systemClock);
            }
          }
        } catch {
          // best-effort GRC maintenance
        }
      })(),
    );
  },
};
