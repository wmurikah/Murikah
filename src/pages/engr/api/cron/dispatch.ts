export const prerender = false;

/**
 * Manual and scheduled trigger for the notification dispatcher. The Worker's
 * scheduled() handler runs the same drain on a Cron Trigger; this HTTP route
 * gives operators a way to drain on demand and gives environments without a
 * wired scheduled handler a way to run the cron. Guarded by ENGR_CRON_SECRET
 * (header x-cron-secret or ?secret=), not a user session.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDeliveryEnv } from '@engr/notify/env';
import { getDb } from '@engr/db';
import { runDispatch } from '@engr/notify/dispatch';
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
  const summary = await runDispatch(db, delivery, systemClock, { limit: 100 });
  return jsonResponse({ ok: true, summary }, 200);
};
