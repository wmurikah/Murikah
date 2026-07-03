export const prerender = false;

/**
 * Contractor assigns a technician from their team. Gate: technicians.manage (the
 * key the seeded CONTRACTOR role holds). The technician must be active and belong
 * to the work order's contractor, so a forged id cannot cross teams.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { applyTransition, WO_ACTION } from '@engr/workflow/workOrderState';
import {
  jsonResponse,
  readBody,
  str,
  wantsJson,
  redirectResponse,
  finishTransition,
} from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/contractor/workorders/${id}`;

  const body = await readBody(request);
  const technicianId = str(body.technician_id).trim();
  const db = await getDb(getEngrEnv());

  // The technician must belong to this work order's contractor, in this org.
  const woRow = await db.execute({
    sql: `SELECT contractor_id FROM work_orders WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [id, engr.orgId],
  });
  const contractorId = woRow.rows[0]?.contractor_id;
  let valid = false;
  if (technicianId && contractorId != null) {
    const tech = await db.execute({
      sql: `SELECT 1 FROM technicians
             WHERE id = ? AND org_id = ? AND contractor_id = ? AND deleted_at IS NULL AND status = 'ACTIVE'
             LIMIT 1`,
      args: [technicianId, engr.orgId, String(contractorId)],
    });
    valid = tech.rows.length > 0;
  }
  if (!valid) {
    return wantsJson(request)
      ? jsonResponse(
          { ok: false, error: 'invalid', message: 'Choose a technician from your team.' },
          422,
        )
      : redirectResponse(request, back, 'error=invalid');
  }

  const result = await applyTransition(
    db,
    { orgId: engr.orgId, userId: engr.userId, perms: engr.perms },
    id,
    WO_ACTION.assign_technician,
    { technicianId },
  );
  return finishTransition(request, result, db, engr.orgId, id, back);
};
