export const prerender = false;

/** Attach an approved cost to a draft bill, with the one-bill guard. Gate: bill.create, plus ownership in the ladder. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { attachCost } from '@engr/workflow/billState';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/engr/bills/${id}`;
  if (!engr.perms.includes('bill.create')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }
  const body = await readBody(request);
  const costId = str(body.cost_id).trim();
  if (!costId) {
    return wantsJson(request)
      ? jsonResponse({ error: 'validation', message: 'Choose a cost.' }, 422)
      : redirectResponse(request, back, 'error=validation');
  }
  const db = await getDb(getEngrEnv());
  const result = await attachCost(db, { orgId: engr.orgId, userId: engr.userId }, id, costId);
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, back, 'attached=1');
  }
  const status =
    result.code === 'forbidden'
      ? 403
      : result.code === 'conflict'
        ? 409
        : result.code === 'not_found'
          ? 404
          : 422;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, back, `error=${result.code}`);
};
