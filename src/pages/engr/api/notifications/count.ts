export const prerender = false;

/**
 * The current user's unread in-app notification count, as JSON. The notification
 * bell polls this on a light interval and after each navigation so the badge
 * stays current without a full page load. Scoped to the acting organisation and
 * the signed-in user; the count never crosses organisations.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { getUnreadCount } from '@engr/notify';

export const GET: APIRoute = async ({ locals }) => {
  const engr = locals.engr;
  if (!engr) return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401 });
  const db = await getDb(getEngrEnv());
  const count = await getUnreadCount(db, engr.orgId, engr.userId);
  return new Response(JSON.stringify({ count }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};
