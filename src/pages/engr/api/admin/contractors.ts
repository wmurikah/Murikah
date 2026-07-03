export const prerender = false;

/** Contractors admin write endpoint. Create when no id is posted, otherwise update. Gate: contractors.manage. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import {
  createContractor,
  updateContractor,
  type ContractorInput,
} from '@engr/repos/adminContractors';
import { jsonResponse, wantsJson } from '@engr/workflow/respond';

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('contractors.manage')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : seeOther('/admin/contractors?error=forbidden');
  }

  // readBody collapses duplicate keys, so read the raw body once here and pull
  // the multi-select checkbox groups out with getAll.
  const ct = request.headers.get('content-type') ?? '';
  let scalar: Record<string, unknown> = {};
  let stationIds: string[] = [];
  let categoryIds: string[] = [];
  if (ct.includes('application/json')) {
    const j = (await request.json()) as Record<string, unknown>;
    scalar = j;
    stationIds = Array.isArray(j.station_ids) ? j.station_ids.map(String) : [];
    categoryIds = Array.isArray(j.category_ids) ? j.category_ids.map(String) : [];
  } else {
    const form = await request.formData();
    for (const [k, v] of form.entries()) scalar[k] = v;
    stationIds = form.getAll('station_ids').map(String).filter(Boolean);
    categoryIds = form.getAll('category_ids').map(String).filter(Boolean);
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

  const id = str(scalar.id).trim();
  const input: ContractorInput = {
    name: str(scalar.name).trim(),
    contactPerson: str(scalar.contact_person).trim() || null,
    email: str(scalar.email).trim() || null,
    phone: str(scalar.phone).trim() || null,
    baseStationId: str(scalar.base_station_id).trim() || null,
    isPrequalified: str(scalar.is_prequalified) === 'on' || str(scalar.is_prequalified) === '1',
    status: str(scalar.status).trim() || 'ACTIVE',
    stationIds,
    categoryIds,
  };

  const db = await getDb(getEngrEnv());
  const ctx = { orgId: engr.orgId, userId: engr.userId };
  const result = id
    ? await updateContractor(db, ctx, id, input)
    : await createContractor(db, ctx, input);

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, id ? 200 : 201)
      : seeOther('/admin/contractors?saved=1');
  }
  const status = result.code === 'conflict' ? 409 : result.code === 'not_found' ? 404 : 422;
  if (wantsJson(request)) {
    return jsonResponse({ ok: false, error: result.code, message: result.message }, status);
  }
  return seeOther(`/admin/contractors/${id || 'new'}?error=${result.code}`);
};
