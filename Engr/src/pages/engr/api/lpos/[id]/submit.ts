export const prerender = false;

/** Submit an LPO draft for manager approval. Gate: lpo.submit. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { submitLpo } from '@engr/repos/lpos';
import { jsonResponse, wantsJson, redirectResponse } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/lpos/${id}`;
  if (!engr.perms.includes('lpo.submit')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }
  const db = await getDb(getEngrEnv(), locals);
  const result = await submitLpo(db, { orgId: engr.orgId, userId: engr.userId }, id);
  if (result.ok)
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, back, 'submitted=1');
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, 409)
    : redirectResponse(request, back, `error=${result.code}`);
};
