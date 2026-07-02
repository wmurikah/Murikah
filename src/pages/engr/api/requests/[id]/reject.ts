export const prerender = false;

/** Engineer rejects an OPEN request with a reason. Gate: requests.reject. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { rejectRequest } from '@engr/repos/requestActions';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/engr/requests/${id}`;

  if (!engr.perms.includes('requests.reject')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const body = await readBody(request);
  const reason = str(body.reason).trim().slice(0, 500);

  const db = await getDb(getEngrEnv());
  const result = await rejectRequest(db, engr.orgId, engr.userId, id, reason);
  if (result.ok) {
    return wantsJson(request) ? jsonResponse({ ok: true }, 200) : redirectResponse(request, back);
  }
  const status = result.code === 'conflict' ? 409 : 404;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, back, `error=${result.code}`);
};
