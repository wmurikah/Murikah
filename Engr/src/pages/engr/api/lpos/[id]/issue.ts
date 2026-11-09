export const prerender = false;

/** Issue an already approved LPO to its contractor. Gate: lpo.issue. */
import type { APIRoute } from 'astro';
import { requireFreshMfa } from '@engr/auth/sensitiveAction';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { issueLpo } from '@engr/repos/lpos';
import { jsonResponse, wantsJson, redirectResponse } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const mfaGate = requireFreshMfa(request, locals);
  if (mfaGate) return mfaGate;
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/lpos/${id}`;
  if (!engr.perms.includes('lpo.issue')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }
  const db = await getDb(getEngrEnv());
  const result = await issueLpo(db, { orgId: engr.orgId, userId: engr.userId }, id);
  if (result.ok)
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, back, 'issued=1');
  const status = result.code === 'not_found' ? 404 : 409;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, back, `error=${result.code}`);
};
