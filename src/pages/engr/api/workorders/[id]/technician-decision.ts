export const prerender = false;

/**
 * Assigned technician accepts or rejects the work order. No dedicated permission
 * key; gated on workorder.view plus the ownership rule in the state machine (the
 * acting user must be the assigned technician's portal account).
 */
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

  const body = await readBody(request);
  const action =
    str(body.decision).toLowerCase() === 'reject'
      ? WO_ACTION.technician_reject
      : WO_ACTION.technician_accept;

  const db = await getDb(getEngrEnv());
  const result = await applyTransition(
    db,
    { orgId: engr.orgId, userId: engr.userId, perms: engr.perms },
    id,
    action,
    { reason: str(body.reason).trim().slice(0, 500) },
  );
  return finishTransition(request, result, db, engr.orgId, id, `/technician/workorders/${id}`);
};
