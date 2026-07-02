export const prerender = false;

/**
 * Engineer assigns a pre-qualified contractor on predefined rates, creating the
 * work order in CONTRACTOR_NOTIFIED. Gate: workorder.create and workorder.assign.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createWorkOrderFromRequest } from '@engr/repos/workOrders';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/engr/requests/${id}`;

  if (!(engr.perms.includes('workorder.create') && engr.perms.includes('workorder.assign'))) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const body = await readBody(request);
  const contractorId = str(body.contractor_id).trim();
  const slaId = str(body.sla_id).trim() || null;
  if (!contractorId) {
    return wantsJson(request)
      ? jsonResponse({ error: 'validation', message: 'Choose a contractor.' }, 422)
      : redirectResponse(request, back, 'error=validation');
  }

  const db = await getDb(getEngrEnv());
  const result = await createWorkOrderFromRequest(
    db,
    { orgId: engr.orgId, userId: engr.userId },
    { requestId: id, contractorId, slaId },
  );

  if (result.ok) {
    const woPath = `/engr/workorders/${result.workOrderId}`;
    return wantsJson(request)
      ? jsonResponse({ ok: true, workOrderId: result.workOrderId, woNo: result.woNo }, 201)
      : redirectResponse(request, woPath);
  }
  const status = result.code === 'conflict' ? 409 : result.code === 'not_found' ? 404 : 422;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, back, `error=${result.code}`);
};
