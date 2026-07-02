export const prerender = false;

/**
 * Assigned technician either starts work (TECH_ONSITE to IN_PROGRESS, action
 * "start") or completes the job card with spares and requests closure. Gate:
 * jobcard.submit plus technician ownership (enforced by the state machine).
 * Spares are read from up to six fixed rows; a rate item, when chosen, prices
 * the line from the rate card.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { applyTransition, WO_ACTION, type TransitionPayload } from '@engr/workflow/workOrderState';
import { jsonResponse, readBody, str, finishTransition } from '@engr/workflow/respond';

const MAX_SPARE_ROWS = 6;

function parseSpares(body: Record<string, unknown>): TransitionPayload['spares'] {
  const spares: NonNullable<TransitionPayload['spares']> = [];
  for (let i = 1; i <= MAX_SPARE_ROWS; i++) {
    const description = str(body[`spare_${i}_desc`]).trim();
    if (!description) continue;
    const rateItemId = str(body[`spare_${i}_rate_item`]).trim() || null;
    const qtyRaw = Number(str(body[`spare_${i}_qty`]));
    const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
    spares.push({ rateItemId, description: description.slice(0, 300), qty });
  }
  return spares;
}

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/engr/technician/workorders/${id}`;

  const body = await readBody(request);
  const ctx = { orgId: engr.orgId, userId: engr.userId, perms: engr.perms };
  const db = await getDb(getEngrEnv());

  if (str(body.action).toLowerCase() === 'start') {
    const started = await applyTransition(db, ctx, id, WO_ACTION.start_work, {});
    return finishTransition(request, started, db, engr.orgId, id, back);
  }

  const result = await applyTransition(db, ctx, id, WO_ACTION.submit_jobcard_request_closure, {
    jobCard: {
      diagnosis: str(body.diagnosis).trim().slice(0, 2000),
      rootCause: str(body.root_cause).trim().slice(0, 2000),
      repairDone: str(body.repair_done).trim().slice(0, 2000),
    },
    spares: parseSpares(body),
  });
  return finishTransition(request, result, db, engr.orgId, id, back);
};
