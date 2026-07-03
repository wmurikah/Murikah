export const prerender = false;

/** Submit a bill to level 1. Gate: bill.create and bill.submit, plus ownership in the ladder. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { submitBill } from '@engr/workflow/billState';
import { jsonResponse, wantsJson, redirectResponse } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/bills/${id}`;
  if (!(engr.perms.includes('bill.create') && engr.perms.includes('bill.submit'))) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }
  const db = await getDb(getEngrEnv());
  const result = await submitBill(db, { orgId: engr.orgId, userId: engr.userId }, id);
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, back, 'submitted=1');
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
