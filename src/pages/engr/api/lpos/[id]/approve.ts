export const prerender = false;

/**
 * Approve a draft LPO. Gate: cost.approve.l2 (the engineering manager; OWNER and
 * ADMIN hold every permission). An LPO is a financial commitment, so it must be
 * approved before it can be issued. Guarded in the repository against a
 * non-draft, cancelled or sealed LPO.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { approveLpo } from '@engr/repos/lpoAudit';
import { jsonResponse, wantsJson, redirectResponse } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/lpos/${id}`;

  if (!engr.perms.includes('cost.approve.l2')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const db = await getDb(getEngrEnv());
  const result = await approveLpo(db, { orgId: engr.orgId, userId: engr.userId }, id);
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, back, 'approved=1');
  }
  const status =
    result.code === 'not_found'
      ? 404
      : result.code === 'conflict'
        ? 409
        : result.code === 'forbidden'
          ? 403
          : 422;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, back, `error=${result.code}`);
};
