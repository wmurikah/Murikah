export const prerender = false;

/**
 * Manual and scheduled trigger for the daily PM scan. The Worker's scheduled()
 * handler runs the same scan once a day on a Cron Trigger; this HTTP route lets
 * operators run it on demand and lets environments without a wired scheduled
 * handler run the cron. Guarded by ENGR_CRON_SECRET, not a user session. The
 * scan is idempotent, so an extra run is safe.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDeliveryEnv } from '@engr/notify/env';
import { getDb } from '@engr/db';
import { runPmScan } from '@engr/workflow/pmScan';
import { systemClock } from '@engr/time';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const delivery = getDeliveryEnv();
  if (!delivery.cronSecret) return jsonResponse({ error: 'cron not configured' }, 503);
  const provided =
    request.headers.get('x-cron-secret') ?? new URL(request.url).searchParams.get('secret') ?? '';
  if (provided !== delivery.cronSecret) return jsonResponse({ error: 'unauthorised' }, 401);

  const db = await getDb(getEngrEnv());
  const summary = await runPmScan(db, delivery, systemClock, { orgLimit: 50, scheduleLimit: 200 });
  return jsonResponse({ ok: true, summary }, 200);
};
