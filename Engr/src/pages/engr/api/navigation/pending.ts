export const prerender = false;

/**
 * Read-only live work counters for the authenticated user's visible sidebar.
 * Unlike unread-message badges, these represent workflow work still actionable.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { eatDateString } from '@engr/time';
import { getPendingNavigationCounts } from '@engr/repos/navigationPending';

export const GET: APIRoute = async ({ locals }) => {
  const engr = locals.engr;
  if (!engr)
    return new Response(JSON.stringify({ error: 'unauthorised' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });

  try {
    const db = await getDb(getEngrEnv(), locals);
    const counts = await getPendingNavigationCounts(db, engr, eatDateString(new Date()));
    return new Response(JSON.stringify({ counts }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (error) {
    console.error('[engr.navigation.pending] failed', error);
    return new Response(JSON.stringify({ error: 'unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
};
