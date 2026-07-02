export const prerender = false;

/**
 * LPO detail as JSON: the work orders across stations and the single mileage
 * claim. Gate: workorder.view. A contractor may read only their own LPO.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { getLpoDetail } from '@engr/repos/lpos';
import { contractorForUser } from '@engr/repos/techniciansPick';
import { jsonResponse } from '@engr/workflow/respond';

export const GET: APIRoute = async ({ locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('workorder.view')) return jsonResponse({ error: 'forbidden' }, 403);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);

  const db = await getDb(getEngrEnv());
  const lpo = await getLpoDetail(db, engr.orgId, id);
  if (!lpo) return jsonResponse({ ok: false, error: 'not_found' }, 404);

  if (!engr.perms.includes('workorder.create')) {
    const contractorId = await contractorForUser(db, engr.orgId, engr.userId);
    if (!contractorId || contractorId !== lpo.contractorId) {
      return jsonResponse({ error: 'forbidden' }, 403);
    }
  }
  return jsonResponse({ ok: true, lpo }, 200);
};
