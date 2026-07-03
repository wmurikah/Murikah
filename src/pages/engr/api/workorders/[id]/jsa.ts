export const prerender = false;

/**
 * Assigned technician submits a job safety analysis and requests arrival. Gate:
 * jsa.submit plus technician ownership (enforced by the state machine). Opens a
 * pending site arrival and notifies the station manager.
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
  const jsaContent = {
    summary: str(body.summary).trim().slice(0, 2000),
    hazards: str(body.hazards).trim().slice(0, 2000),
    controls: str(body.controls).trim().slice(0, 2000),
  };

  const db = await getDb(getEngrEnv());
  const result = await applyTransition(
    db,
    { orgId: engr.orgId, userId: engr.userId, perms: engr.perms },
    id,
    WO_ACTION.submit_jsa_request_arrival,
    { jsaContent },
  );
  return finishTransition(request, result, db, engr.orgId, id, `/technician/workorders/${id}`);
};
