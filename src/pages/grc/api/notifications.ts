export const prerender = false;

/**
 * The in-app bell: the signed-in user's unread count and recent items (GET, as
 * JSON for the live poll), and mark-as-read (POST, one by id or all). Scoped to
 * the acting organisation and the user; returns 401 without a session.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { unreadCount, listInApp, markRead, markAllRead } from '@grc/repos/inApp';

export const GET: APIRoute = async ({ locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(JSON.stringify({ error: 'unauthorised' }), { status: 401 });
  const db = await getDb(getGrcEnv());
  const [unread, items] = await Promise.all([
    unreadCount(db, grc.userId),
    listInApp(db, grc.userId, 15),
  ]);
  return new Response(JSON.stringify({ unread, items }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });

  const form = await request.formData();
  const id = String(form.get('id') ?? '').trim();
  const all = String(form.get('all') ?? '') === '1';
  const db = await getDb(getGrcEnv());
  if (all) await markAllRead(db, grc.userId);
  else if (id) await markRead(db, grc.userId, id);

  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('application/json')) {
    const unread = await unreadCount(db, grc.userId);
    return new Response(JSON.stringify({ ok: true, unread }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(null, { status: 303, headers: { location: '/notifications' } });
};
