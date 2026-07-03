export const prerender = false;

/** Assets admin write endpoint. Create when no id is posted, otherwise update. Gate: assets.manage. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createAsset, updateAsset, type AssetInput } from '@engr/repos/adminAssets';
import { jsonResponse, wantsJson, readBody, str } from '@engr/workflow/respond';

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('assets.manage')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : seeOther('/admin/assets?error=forbidden');
  }

  const body = await readBody(request);
  const id = str(body.id).trim();
  const input: AssetInput = {
    tag: str(body.tag).trim(),
    name: str(body.name).trim(),
    stationId: str(body.station_id).trim(),
    categoryId: str(body.category_id).trim() || null,
    manufacturer: str(body.manufacturer).trim() || null,
    model: str(body.model).trim() || null,
    serialNo: str(body.serial_no).trim() || null,
    installDate: str(body.install_date).trim() || null,
    status: str(body.status).trim() || 'IN_SERVICE',
  };

  const db = await getDb(getEngrEnv());
  const ctx = { orgId: engr.orgId, userId: engr.userId };
  const result = id ? await updateAsset(db, ctx, id, input) : await createAsset(db, ctx, input);

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, id ? 200 : 201)
      : seeOther('/admin/assets?saved=1');
  }
  const status = result.code === 'conflict' ? 409 : result.code === 'not_found' ? 404 : 422;
  if (wantsJson(request)) {
    return jsonResponse({ ok: false, error: result.code, message: result.message }, status);
  }
  return seeOther(`/admin/assets/${id || 'new'}?error=${result.code}`);
};
