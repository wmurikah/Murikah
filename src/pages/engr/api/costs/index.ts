export const prerender = false;

/**
 * Work costs.
 *  POST: contractor raises a cost for a closed work order. Gate: cost.create.
 *  GET:  the caller's contractor costs (org-scoped).
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createCost } from '@engr/workflow/costState';
import { listCostsForContractor } from '@engr/repos/workCosts';
import { contractorForUser } from '@engr/repos/techniciansPick';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('cost.create')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, '/contractor/costs', 'error=forbidden');
  }
  const body = await readBody(request);
  const workOrderId = str(body.work_order_id).trim();
  if (!workOrderId) {
    return wantsJson(request)
      ? jsonResponse({ error: 'validation', message: 'Choose a work order.' }, 422)
      : redirectResponse(request, '/contractor/costs', 'error=validation');
  }
  const db = await getDb(getEngrEnv());
  const result = await createCost(db, { orgId: engr.orgId, userId: engr.userId }, workOrderId);
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, costId: result.costId }, 201)
      : redirectResponse(request, `/costs/${result.costId}`);
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
    : redirectResponse(request, '/contractor/costs', `error=${result.code}`);
};

export const GET: APIRoute = async ({ locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('cost.view')) return jsonResponse({ error: 'forbidden' }, 403);
  const db = await getDb(getEngrEnv());
  const contractorId = await contractorForUser(db, engr.orgId, engr.userId);
  const rows = contractorId ? await listCostsForContractor(db, engr.orgId, contractorId) : [];
  return jsonResponse({ ok: true, costs: rows }, 200);
};
