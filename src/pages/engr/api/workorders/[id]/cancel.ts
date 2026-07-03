export const prerender = false;

/** Engineer cancels a non-terminal work order with a reason. Gate: workorder.close. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { applyTransition, WO_ACTION } from '@engr/workflow/workOrderState';
import { jsonResponse, readBody, str, finishTransition } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);

  const db = await getDb(getEngrEnv());
  const body = await readBody(request);
  const result = await applyTransition(
    db,
    { orgId: engr.orgId, userId: engr.userId, perms: engr.perms },
    id,
    WO_ACTION.cancel,
    { reason: str(body.reason).trim().slice(0, 500) },
  );
  return finishTransition(request, result, db, engr.orgId, id, `/workorders/${id}`);
};
