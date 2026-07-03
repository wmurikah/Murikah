export const prerender = false;

/** Stations admin write endpoint. Create when no id is posted, otherwise update. Gate: stations.manage. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createStation, updateStation, type StationInput } from '@engr/repos/adminStations';
import { jsonResponse, wantsJson, readBody, str } from '@engr/workflow/respond';

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('stations.manage')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : seeOther('/admin/stations?error=forbidden');
  }

  const body = await readBody(request);
  const id = str(body.id).trim();
  const input: StationInput = {
    code: str(body.code).trim(),
    name: str(body.name).trim(),
    regionId: str(body.region_id).trim() || null,
    address: str(body.address).trim() || null,
    stationManagerId: str(body.station_manager_id).trim() || null,
    isBase: str(body.is_base) === 'on' || str(body.is_base) === '1',
    status: str(body.status).trim() || 'ACTIVE',
  };

  const db = await getDb(getEngrEnv());
  const ctx = { orgId: engr.orgId, userId: engr.userId };
  const result = id ? await updateStation(db, ctx, id, input) : await createStation(db, ctx, input);

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, id ? 200 : 201)
      : seeOther('/admin/stations?saved=1');
  }
  const status = result.code === 'conflict' ? 409 : result.code === 'not_found' ? 404 : 422;
  if (wantsJson(request)) {
    return jsonResponse({ ok: false, error: result.code, message: result.message }, status);
  }
  return seeOther(`/admin/stations/${id || 'new'}?error=${result.code}`);
};
