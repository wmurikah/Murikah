export const prerender = false;

/**
 * Level-aware cost decision. Level 1 gates on cost.approve.l1, level 2 on
 * cost.approve.l2. The ladder enforces segregation of duties and the status
 * guard: a stale or out-of-sequence action is a 409, an SoD failure a 403.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { decideCost } from '@engr/workflow/costState';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/engr/costs/${id}`;

  const body = await readBody(request);
  const level = Number(str(body.level));
  const decision = str(body.decision).trim();
  if ((level !== 1 && level !== 2) || (decision !== 'approve' && decision !== 'reject')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'validation' }, 422)
      : redirectResponse(request, back, 'error=validation');
  }
  const key = level === 1 ? 'cost.approve.l1' : 'cost.approve.l2';
  if (!engr.perms.includes(key)) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const db = await getDb(getEngrEnv());
  const result = await decideCost(
    db,
    { orgId: engr.orgId, userId: engr.userId },
    id,
    level as 1 | 2,
    decision as 'approve' | 'reject',
    str(body.comment).trim(),
  );
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, back, `done=${decision}`);
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
