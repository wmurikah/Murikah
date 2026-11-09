export const prerender = false;

/** Bill detail as JSON with cost lines, the approval trail and payments. Gate: bill.view; a contractor sees only their own. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { getBillDetail } from '@engr/repos/bills';
import { contractorForUser } from '@engr/repos/techniciansPick';
import { jsonResponse } from '@engr/workflow/respond';
import { actorDataScope } from '@engr/auth/dataScope';

export const GET: APIRoute = async ({ locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('bill.view')) return jsonResponse({ error: 'forbidden' }, 403);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const db = await getDb(getEngrEnv(), locals);
  const bill = await getBillDetail(db, engr.orgId, id);
  if (!bill) return jsonResponse({ ok: false, error: 'not_found' }, 404);

  if (actorDataScope(engr.roles) === 'contractor') {
    const contractorId = await contractorForUser(db, engr.orgId, engr.userId);
    if (!contractorId || contractorId !== bill.contractorId) {
      return jsonResponse({ error: 'forbidden' }, 403);
    }
  }
  return jsonResponse({ ok: true, bill }, 200);
};
