export const prerender = false;

/** Technicians admin write endpoint. Create when no id is posted, otherwise update. Gate: technicians.manage. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import {
  createTechnician,
  updateTechnician,
  type TechnicianInput,
} from '@engr/repos/adminTechnicians';
import { jsonResponse, wantsJson, readBody, str } from '@engr/workflow/respond';

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('technicians.manage')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : seeOther('/admin/technicians?error=forbidden');
  }

  const body = await readBody(request);
  const id = str(body.id).trim();
  const input: TechnicianInput = {
    contractorId: str(body.contractor_id).trim(),
    fullName: str(body.full_name).trim(),
    phone: str(body.phone).trim() || null,
    email: str(body.email).trim() || null,
    status: str(body.status).trim() || 'ACTIVE',
  };

  const db = await getDb(getEngrEnv());
  const ctx = { orgId: engr.orgId, userId: engr.userId };
  const result = id
    ? await updateTechnician(db, ctx, id, input)
    : await createTechnician(db, ctx, input);

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, id ? 200 : 201)
      : seeOther('/admin/technicians?saved=1');
  }
  const status = result.code === 'conflict' ? 409 : result.code === 'not_found' ? 404 : 422;
  if (wantsJson(request)) {
    return jsonResponse({ ok: false, error: result.code, message: result.message }, status);
  }
  return seeOther(`/admin/technicians/${id || 'new'}?error=${result.code}`);
};
