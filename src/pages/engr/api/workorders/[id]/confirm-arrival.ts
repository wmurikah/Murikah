export const prerender = false;

/**
 * Station manager confirms the technician's arrival, moving the work order to
 * TECH_ONSITE. Gate: arrival.confirm or station-manager ownership (enforced by
 * the state machine).
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { applyTransition, WO_ACTION } from '@engr/workflow/workOrderState';
import { jsonResponse, finishTransition } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);

  const db = await getDb(getEngrEnv());
  const result = await applyTransition(
    db,
    { orgId: engr.orgId, userId: engr.userId, perms: engr.perms },
    id,
    WO_ACTION.confirm_arrival,
    {},
  );
  return finishTransition(request, result, db, engr.orgId, id, '/station/confirmations');
};
