export const prerender = false;

/**
 * Contractor raises or submits the one mileage claim for the LPO trip. Gate:
 * cost.create and cost.submit, plus ownership of the LPO's contractor (enforced
 * in the repository). The amount is computed server-side; a client amount is
 * ignored. action=save leaves it DRAFT; the default submits it.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { raiseClaim, submitClaim, type ClaimResult } from '@engr/repos/mileageClaims';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

function statusFor(code: string): number {
  return code === 'forbidden' ? 403 : code === 'not_found' ? 404 : code === 'conflict' ? 409 : 422;
}

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/engr/contractor/lpos/${id}`;

  if (!(engr.perms.includes('cost.create') && engr.perms.includes('cost.submit'))) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const body = await readBody(request);
  const action = str(body.action).trim() || 'submit';
  const distanceKm = Number(str(body.distance_km)) || 0;
  const referencedToStationId = str(body.referenced_to_station_id).trim() || null;
  const ctx = { orgId: engr.orgId, userId: engr.userId };
  const db = await getDb(getEngrEnv());

  let result: ClaimResult;
  if (action === 'save') {
    result = await raiseClaim(db, ctx, { lpoId: id, referencedToStationId, distanceKm });
  } else {
    const raised = await raiseClaim(db, ctx, { lpoId: id, referencedToStationId, distanceKm });
    // A fresh draft submits directly; an existing draft (raise conflicts) submits too.
    result = raised.ok || raised.code === 'conflict' ? await submitClaim(db, ctx, id) : raised;
  }

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, claimId: result.claimId }, action === 'save' ? 201 : 200)
      : redirectResponse(request, back, action === 'save' ? 'saved=1' : 'submitted=1');
  }
  return wantsJson(request)
    ? jsonResponse(
        { ok: false, error: result.code, message: result.message },
        statusFor(result.code),
      )
    : redirectResponse(request, back, `error=${result.code}`);
};
