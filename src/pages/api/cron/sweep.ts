export const prerender = false;

import { env } from 'cloudflare:workers';
import type { APIRoute } from 'astro';
import { json } from '@/lib/http';
import { runRetentionSweep } from '@/lib/demo/sweep';

/**
 * Retention sweep. Called by the companion Cron Worker (workers/cron.ts) on a
 * schedule, with the shared CRON_SECRET. Deletes demo data and old sessions
 * past 24 hours and prunes assistant logs past 30 days.
 */
export const POST: APIRoute = async ({ request }) => {
  const secret = env.CRON_SECRET;
  if (!secret) return json({ ok: false, error: 'Sweep is not configured.' }, 503);

  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${secret}`) return json({ ok: false, error: 'Unauthorised.' }, 401);

  try {
    const counts = await runRetentionSweep(env);
    return json({ ok: true, counts });
  } catch {
    return json({ ok: false, error: 'Sweep failed. Is the database configured?' }, 500);
  }
};
