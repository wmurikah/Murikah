export const prerender = false;

/** Engineer accepts an OPEN request, moving it to ACCEPTED. Gate: requests.accept. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { acceptRequest } from '@engr/repos/requestActions';
import { jsonResponse, wantsJson, redirectResponse } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/requests/${id}`;

  if (!engr.perms.includes('requests.accept')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const db = await getDb(getEngrEnv());
  const result = await acceptRequest(db, engr.orgId, engr.userId, id);
  if (result.ok) {
    return wantsJson(request) ? jsonResponse({ ok: true }, 200) : redirectResponse(request, back);
  }
  const status = result.code === 'conflict' ? 409 : 404;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, back, `error=${result.code}`);
};
