export const prerender = false;

/**
 * Cancel an LPO. Gate: workorder.create and workorder.assign. Cancellation sets
 * cancelled_at and a reason and moves the status to CANCELLED; it never deletes,
 * so a cancelled LPO stays, sealed, in the record.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { cancelLpo } from '@engr/repos/lpoAudit';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

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

  const body = await readBody(request);
  const reason = str(body.reason);
  const db = await getDb(getEngrEnv());
  const result = await cancelLpo(db, { orgId: engr.orgId, userId: engr.userId }, id, reason);
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, back, 'cancelled=1');
  }
  const status = result.code === 'not_found' ? 404 : result.code === 'conflict' ? 409 : 422;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, back, `error=${result.code}`);
};
