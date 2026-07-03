export const prerender = false;

/**
 * Bills.
 *  POST: contractor raises a bill for a period. Gate: bill.create.
 *  GET:  the caller's contractor bills (org-scoped).
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createBill } from '@engr/workflow/billState';
import { listBillsForContractor } from '@engr/repos/bills';
import { contractorForUser } from '@engr/repos/techniciansPick';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('bill.create')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, '/contractor/bills', 'error=forbidden');
  }
  const body = await readBody(request);
  const db = await getDb(getEngrEnv());
  const result = await createBill(
    db,
    { orgId: engr.orgId, userId: engr.userId },
    {
      periodLabel: str(body.period_label).trim() || null,
      periodStart: str(body.period_start).trim() || null,
      periodEnd: str(body.period_end).trim() || null,
    },
  );
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, billId: result.billId, billNo: result.billNo }, 201)
      : redirectResponse(request, `/bills/${result.billId}`);
  }
  const status = result.code === 'forbidden' ? 403 : result.code === 'conflict' ? 409 : 422;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, '/contractor/bills', `error=${result.code}`);
};

export const GET: APIRoute = async ({ locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('bill.view')) return jsonResponse({ error: 'forbidden' }, 403);
  const db = await getDb(getEngrEnv());
  const contractorId = await contractorForUser(db, engr.orgId, engr.userId);
  const rows = contractorId ? await listBillsForContractor(db, engr.orgId, contractorId) : [];
  return jsonResponse({ ok: true, bills: rows }, 200);
};
