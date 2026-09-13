export const prerender = false;

/**
 * Issue and seal an approved LPO. Gate: workorder.create and workorder.assign
 * (the raiser issues their approved document, a senior having approved it). In one
 * transaction the repository freezes the lines into lpo_lines, reconciles the
 * total to lines plus approved mileage, computes the seal hash, and stamps issued
 * and sealed. Guarded against a non-approved, cancelled or already-sealed LPO.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { issueLpo } from '@engr/repos/lpoAudit';
import { jsonResponse, wantsJson, redirectResponse } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/lpos/${id}`;

  if (!(engr.perms.includes('workorder.create') && engr.perms.includes('workorder.assign'))) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const db = await getDb(getEngrEnv());
  const result = await issueLpo(db, { orgId: engr.orgId, userId: engr.userId }, id);
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, back, 'issued=1');
  }
  const status = result.code === 'not_found' ? 404 : result.code === 'conflict' ? 409 : 422;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, back, `error=${result.code}`);
};
