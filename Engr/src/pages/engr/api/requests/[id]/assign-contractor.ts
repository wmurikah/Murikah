export const prerender = false;

/**
 * An engineer prepares a pre-qualified contractor assignment as a CREATED work
 * order draft. A different manager releases it to the contractor. The two
 * actions are independently gated by workorder.create and workorder.assign.
 */
import type { APIRoute } from 'astro';
import { requireFreshMfa } from '@engr/auth/sensitiveAction';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { assignWorkOrderDraft, createWorkOrderFromRequest } from '@engr/repos/workOrders';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const mfaGate = requireFreshMfa(request, locals);
  if (mfaGate) return mfaGate;
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/requests/${id}`;

  const body = await readBody(request);
  const workOrderId = str(body.work_order_id).trim();
  const requiredPermission = workOrderId ? 'workorder.assign' : 'workorder.create';
  if (!engr.perms.includes(requiredPermission)) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const contractorId = str(body.contractor_id).trim();
  const slaId = str(body.sla_id).trim() || null;
  if (!workOrderId && !contractorId) {
    return wantsJson(request)
      ? jsonResponse({ error: 'validation', message: 'Choose a contractor.' }, 422)
      : redirectResponse(request, back, 'error=validation');
  }

  const db = await getDb(getEngrEnv(), locals);
  const result = workOrderId
    ? await assignWorkOrderDraft(db, { orgId: engr.orgId, userId: engr.userId }, id, workOrderId)
    : await createWorkOrderFromRequest(
        db,
        { orgId: engr.orgId, userId: engr.userId },
        { requestId: id, contractorId, slaId },
      );

  if (result.ok) {
    const woPath = `/workorders/${result.workOrderId}`;
    return wantsJson(request)
      ? jsonResponse({ ok: true, workOrderId: result.workOrderId, woNo: result.woNo }, 201)
      : redirectResponse(request, woPath);
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
