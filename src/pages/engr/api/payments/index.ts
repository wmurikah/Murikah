export const prerender = false;

/**
 * Payments.
 *  POST: record a payment against a ready bill. Gate: payment.record, plus the
 *        approver-versus-payer switch in the payments module.
 *  GET:  payments for a bill (?bill=id), or the bills ready for payment.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { recordPayment, listPaymentsForBill, listReadyBills } from '@engr/repos/payments';
import {
  jsonResponse,
  wantsJson,
  redirectResponse,
  readBody,
  str,
  toMinorUnits,
} from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const back = '/payments';
  if (!engr.perms.includes('payment.record')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }
  const body = await readBody(request);
  const billId = str(body.bill_id).trim();
  const amountMinor = toMinorUnits(body.amount);
  if (!billId || amountMinor == null) {
    return wantsJson(request)
      ? jsonResponse({ error: 'validation', message: 'Enter a bill and amount.' }, 422)
      : redirectResponse(request, back, 'error=validation');
  }
  const db = await getDb(getEngrEnv());
  const result = await recordPayment(
    db,
    { orgId: engr.orgId, userId: engr.userId },
    {
      billId,
      amountMinor,
      method: str(body.method).trim() || null,
      reference: str(body.reference).trim() || null,
      paidAt: str(body.paid_at).trim() || null,
    },
  );
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, paymentId: result.paymentId }, 201)
      : redirectResponse(request, back, 'recorded=1');
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
    : redirectResponse(request, back, `error=${result.code}`);
};

export const GET: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('payment.view')) return jsonResponse({ error: 'forbidden' }, 403);
  const db = await getDb(getEngrEnv());
  const billId = new URL(request.url).searchParams.get('bill');
  if (billId) {
    return jsonResponse(
      { ok: true, payments: await listPaymentsForBill(db, engr.orgId, billId) },
      200,
    );
  }
  return jsonResponse({ ok: true, bills: await listReadyBills(db, engr.orgId) }, 200);
};
