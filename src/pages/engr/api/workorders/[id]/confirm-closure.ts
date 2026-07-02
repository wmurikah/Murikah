export const prerender = false;

/**
 * Station manager confirms closure (to CLOSED, which also closes the request) or
 * reopens the work order (back to IN_PROGRESS with a reason). Gate:
 * jobcard.confirm or station-manager ownership (enforced by the state machine).
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
    str(body.decision).toLowerCase() === 'reopen' ? WO_ACTION.reopen : WO_ACTION.confirm_closure;

  const db = await getDb(getEngrEnv());
  const result = await applyTransition(
    db,
    { orgId: engr.orgId, userId: engr.userId, perms: engr.perms },
    id,
    action,
    { reason: str(body.reason).trim().slice(0, 500) },
  );
  return finishTransition(request, result, db, engr.orgId, id, '/engr/station/confirmations');
};
