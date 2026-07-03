export const prerender = false;

/**
 * Procurement sign-off on an above-threshold award. Gate: rfq.award, plus the
 * segregation-of-duties rule enforced in decideProcurement (the approver must
 * not be the raiser or the sender unless they are an OWNER or ADMIN). Approval
 * creates the work order and sends the caller to it; rejection returns the RFQ
 * to OPEN or CANCELLED. A failed segregation check returns 403, a stale RFQ 409.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { decideProcurement } from '@engr/workflow/rfqAward';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

function statusFor(code: string): number {
  return code === 'forbidden' ? 403 : code === 'conflict' ? 409 : code === 'not_found' ? 404 : 422;
}

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = '/procurement/approvals';

  if (!engr.perms.includes('rfq.award')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const body = await readBody(request);
  const decision = str(body.decision).trim();
  if (decision !== 'approve' && decision !== 'reject') {
    return wantsJson(request)
      ? jsonResponse({ error: 'validation', message: 'Choose approve or reject.' }, 422)
      : redirectResponse(request, back, 'error=validation');
  }
  const reason = str(body.reason).trim();
  const cancel = ['1', 'true', 'on'].includes(str(body.cancel).trim());

  const db = await getDb(getEngrEnv());
  const actor = { orgId: engr.orgId, userId: engr.userId, perms: engr.perms, roles: engr.roles };
  const result = await decideProcurement(db, actor, id, decision, { reason, cancel });

  if (result.ok) {
    if (result.outcome === 'awarded') {
      const woPath = `/workorders/${result.workOrderId}`;
      return wantsJson(request)
        ? jsonResponse(
            { ok: true, outcome: 'awarded', workOrderId: result.workOrderId, woNo: result.woNo },
            201,
          )
        : redirectResponse(request, woPath);
    }
    return wantsJson(request)
      ? jsonResponse({ ok: true, outcome: result.outcome, status: result.status }, 200)
      : redirectResponse(request, back, `done=${result.outcome}`);
  }
  return wantsJson(request)
    ? jsonResponse(
        { ok: false, error: result.code, message: result.message },
        statusFor(result.code),
      )
    : redirectResponse(request, back, `error=${result.code}`);
};
