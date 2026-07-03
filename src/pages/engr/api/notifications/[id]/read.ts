export const prerender = false;

/**
 * Mark one of the current user's in-app notifications as read. Any recipient may
 * mark their own; the repository scopes the write to rows addressed to this user
 * or to a contractor or technician whose portal account they are.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { markRead } from '@engr/repos/notifications';
import { jsonResponse, wantsJson, redirectResponse } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = '/notifications';

  const db = await getDb(getEngrEnv());
  const ok = await markRead(db, engr.orgId, engr.userId, id);
  if (!ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: false, error: 'conflict' }, 409)
      : redirectResponse(request, back, 'error=conflict');
  }
  return wantsJson(request) ? jsonResponse({ ok: true }, 200) : redirectResponse(request, back);
};
