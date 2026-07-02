export const prerender = false;

/** Cost detail as JSON with items and the approval trail. Gate: cost.view; a contractor sees only their own. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { getCostDetail } from '@engr/repos/workCosts';
import { contractorForUser } from '@engr/repos/techniciansPick';
import { jsonResponse } from '@engr/workflow/respond';

export const GET: APIRoute = async ({ locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('cost.view')) return jsonResponse({ error: 'forbidden' }, 403);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const db = await getDb(getEngrEnv());
  const cost = await getCostDetail(db, engr.orgId, id);
  if (!cost) return jsonResponse({ ok: false, error: 'not_found' }, 404);

  const isApprover =
    engr.perms.includes('cost.approve.l1') || engr.perms.includes('cost.approve.l2');
  if (!isApprover) {
    const contractorId = await contractorForUser(db, engr.orgId, engr.userId);
    if (!contractorId || contractorId !== cost.contractorId) {
      return jsonResponse({ error: 'forbidden' }, 403);
    }
  }
  return jsonResponse({ ok: true, cost }, 200);
};
