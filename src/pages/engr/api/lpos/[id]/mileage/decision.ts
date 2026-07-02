export const prerender = false;

/**
 * Engineer approves or rejects the LPO's mileage claim. Gate: cost.approve.l1.
 * The approver may override the distance and the rate (the only place the rate
 * changes); the amount is recomputed server-side. Guarded on SUBMITTED, so a
 * second approver is a clean 409. An approved claim stands as a cost line for the
 * costing prompt.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { approveClaim, rejectClaim } from '@engr/repos/mileageClaims';
import {
  jsonResponse,
  wantsJson,
  redirectResponse,
  readBody,
  str,
  toMinorUnits,
} from '@engr/workflow/respond';

function statusFor(code: string): number {
  return code === 'forbidden' ? 403 : code === 'not_found' ? 404 : code === 'conflict' ? 409 : 422;
}

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = '/engr/mileage/approvals';

  if (!engr.perms.includes('cost.approve.l1')) {
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

  const ctx = { orgId: engr.orgId, userId: engr.userId };
  const db = await getDb(getEngrEnv());

  // The claim id comes from the form; fall back to the LPO's submitted claim.
  let claimId = str(body.claim_id).trim();
  if (!claimId) {
    const found = await db.execute({
      sql: `SELECT id FROM mileage_claims WHERE lpo_id = ? AND org_id = ? AND status = 'SUBMITTED' LIMIT 1`,
      args: [id, engr.orgId],
    });
    claimId = found.rows[0] ? String(found.rows[0].id) : '';
  }
  if (!claimId) {
    return wantsJson(request)
      ? jsonResponse({ ok: false, error: 'not_found', message: 'No claim to decide.' }, 404)
      : redirectResponse(request, back, 'error=not_found');
  }

  const distanceRaw = Number(str(body.distance_override));
  const overrides = {
    distanceKm: Number.isFinite(distanceRaw) && distanceRaw > 0 ? distanceRaw : null,
    ratePerKmMinor: toMinorUnits(body.rate_override),
  };

  const result =
    decision === 'approve'
      ? await approveClaim(db, ctx, claimId, overrides)
      : await rejectClaim(db, ctx, claimId, str(body.reason).trim());

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true }, 200)
      : redirectResponse(request, back, `done=${decision}`);
  }
  return wantsJson(request)
    ? jsonResponse(
        { ok: false, error: result.code, message: result.message },
        statusFor(result.code),
      )
    : redirectResponse(request, back, `error=${result.code}`);
};
