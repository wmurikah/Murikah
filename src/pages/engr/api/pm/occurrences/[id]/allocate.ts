export const prerender = false;

/**
 * Allocate a PM occurrence, which creates a work order at CONTRACTOR_NOTIFIED
 * through the workflow layer and runs it into the Prompt 2 spine. Gate:
 * pm.allocate. On success the caller is sent to the new work order.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { allocateOccurrence } from '@engr/workflow/pmAllocate';
import { jsonResponse, wantsJson, redirectResponse } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/pm/occurrences/${id}`;

  if (!engr.perms.includes('pm.allocate')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const db = await getDb(getEngrEnv());
  const result = await allocateOccurrence(db, { orgId: engr.orgId, userId: engr.userId }, id);
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, workOrderId: result.workOrderId, woNo: result.woNo }, 201)
      : redirectResponse(request, `/workorders/${result.workOrderId}`);
  }
  const status = result.code === 'conflict' ? 409 : result.code === 'not_found' ? 404 : 422;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, back, `error=${result.code}`);
};
