export const prerender = false;

/**
 * LPO collection.
 *  POST: create an LPO for a contractor. Gate: workorder.create and
 *        workorder.assign.
 *  GET:  role-aware list. Engineers (workorder.create) get the org's LPOs; a
 *        contractor gets their own.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createLpo, listLpos, listLposForContractor } from '@engr/repos/lpos';
import { contractorForUser } from '@engr/repos/techniciansPick';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

function canBuild(perms: string[]): boolean {
  return perms.includes('workorder.create') && perms.includes('workorder.assign');
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!canBuild(engr.perms)) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, '/lpos', 'error=forbidden');
  }
  const body = await readBody(request);
  const contractorId = str(body.contractor_id).trim();
  const baseStationId = str(body.base_station_id).trim() || null;
  if (!contractorId) {
    return wantsJson(request)
      ? jsonResponse({ error: 'validation', message: 'Choose a contractor.' }, 422)
      : redirectResponse(request, '/lpos/new', 'error=validation');
  }
  const db = await getDb(getEngrEnv());
  const result = await createLpo(
    db,
    { orgId: engr.orgId, userId: engr.userId },
    { contractorId, baseStationId },
  );
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, lpoId: result.lpoId, lpoNo: result.lpoNo }, 201)
      : redirectResponse(request, `/lpos/${result.lpoId}`);
  }
  const status = result.code === 'conflict' ? 409 : result.code === 'not_found' ? 404 : 422;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, '/lpos/new', `error=${result.code}`);
};

export const GET: APIRoute = async ({ locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('workorder.view')) return jsonResponse({ error: 'forbidden' }, 403);
  const db = await getDb(getEngrEnv());
  if (engr.perms.includes('workorder.create')) {
    return jsonResponse({ ok: true, lpos: await listLpos(db, engr.orgId) }, 200);
  }
  const contractorId = await contractorForUser(db, engr.orgId, engr.userId);
  const rows = contractorId ? await listLposForContractor(db, engr.orgId, contractorId) : [];
  return jsonResponse({ ok: true, lpos: rows }, 200);
};
