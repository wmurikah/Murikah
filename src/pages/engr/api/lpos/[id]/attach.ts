export const prerender = false;

/**
 * Attach a work order to the LPO. With work_order_id, attach an existing work
 * order for the same contractor; otherwise create a new one at the given station
 * under the LPO. Gate: workorder.create and workorder.assign. Attaching never
 * changes a work order's state-machine status; it only sets lpo_id.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { attachWorkOrder, createWorkOrderInLpo } from '@engr/repos/lpos';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

function statusFor(code: string): number {
  return code === 'not_found' ? 404 : code === 'conflict' ? 409 : 422;
}

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/lpos/${id}`;

  if (!(engr.perms.includes('workorder.create') && engr.perms.includes('workorder.assign'))) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const body = await readBody(request);
  const ctx = { orgId: engr.orgId, userId: engr.userId };
  const db = await getDb(getEngrEnv());
  const workOrderId = str(body.work_order_id).trim();

  if (workOrderId) {
    const result = await attachWorkOrder(db, ctx, id, workOrderId);
    if (result.ok) {
      return wantsJson(request)
        ? jsonResponse({ ok: true }, 200)
        : redirectResponse(request, back, 'attached=1');
    }
    return wantsJson(request)
      ? jsonResponse(
          { ok: false, error: result.code, message: result.message },
          statusFor(result.code),
        )
      : redirectResponse(request, back, `error=${result.code}`);
  }

  const stationId = str(body.station_id).trim();
  if (!stationId) {
    return wantsJson(request)
      ? jsonResponse({ error: 'validation', message: 'Choose a station or a work order.' }, 422)
      : redirectResponse(request, back, 'error=validation');
  }
  const result = await createWorkOrderInLpo(db, ctx, {
    lpoId: id,
    stationId,
    categoryId: str(body.category_id).trim() || null,
    slaId: str(body.sla_id).trim() || null,
    mileageReferenceStationId: str(body.mileage_reference_station_id).trim() || null,
  });
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, workOrderId: result.workOrderId, woNo: result.woNo }, 201)
      : redirectResponse(request, back, 'created=1');
  }
  return wantsJson(request)
    ? jsonResponse(
        { ok: false, error: result.code, message: result.message },
        statusFor(result.code),
      )
    : redirectResponse(request, back, `error=${result.code}`);
};
