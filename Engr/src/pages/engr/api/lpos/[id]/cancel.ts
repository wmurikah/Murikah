export const prerender = false;

/** Cancel an LPO before execution begins. Gate: lpo.cancel. */
import type { APIRoute } from 'astro';
import { requireFreshMfa } from '@engr/auth/sensitiveAction';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { cancelLpo } from '@engr/repos/lpos';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const mfaGate = requireFreshMfa(request, locals);
  if (mfaGate) return mfaGate;
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/lpos/${id}`;
  if (!engr.perms.includes('lpo.cancel')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }
  const body = await readBody(request);
  const db = await getDb(getEngrEnv(), locals);
  const result = await cancelLpo(
    db,
    { orgId: engr.orgId, userId: engr.userId },
    id,
    str(body.reason),
  );
  if (result.ok)
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, back, 'cancelled=1');
  const status = result.code === 'invalid' ? 422 : result.code === 'not_found' ? 404 : 409;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, back, `error=${result.code}`);
};
