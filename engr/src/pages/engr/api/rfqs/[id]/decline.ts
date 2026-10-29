export const prerender = false;

/**
 * Contractor declines an RFQ invitation, with an optional reason. Gate:
 * quotes.submit (the capability to respond to an invitation). Moves the
 * invitation to DECLINED and notifies the RFQ owner.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { declineInvitation } from '@engr/repos/quotes';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/contractor/rfqs/${id}`;

  if (!engr.perms.includes('quotes.submit')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const body = await readBody(request);
  const reason = str(body.reason).trim();

  const db = await getDb(getEngrEnv());
  const result = await declineInvitation(
    db,
    { orgId: engr.orgId, userId: engr.userId },
    id,
    reason,
  );

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, '/contractor/rfqs', 'declined=1');
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
