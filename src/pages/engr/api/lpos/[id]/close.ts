export const prerender = false;

/**
 * Close the LPO. Gate: workorder.create and workorder.assign. Guarded in the
 * repository: it closes only when every attached work order is closed or
 * cancelled, else a clean 409.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { closeLpo } from '@engr/repos/lpos';
import { jsonResponse, wantsJson, redirectResponse } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/engr/lpos/${id}`;

  if (!(engr.perms.includes('workorder.create') && engr.perms.includes('workorder.assign'))) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const db = await getDb(getEngrEnv());
  const result = await closeLpo(db, { orgId: engr.orgId, userId: engr.userId }, id);
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, back, 'closed=1');
  }
  const status = result.code === 'not_found' ? 404 : result.code === 'conflict' ? 409 : 422;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, back, `error=${result.code}`);
};
