export const prerender = false;

/**
 * Users admin write endpoint. Create when no id is posted, otherwise update.
 * Gate: users.manage. Role assignment additionally requires roles.manage; when
 * the actor lacks it, role_ids are ignored and the roles are left unchanged.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createUser, updateUser, type UserInput } from '@engr/repos/adminUsers';
import { jsonResponse, wantsJson, str } from '@engr/workflow/respond';

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('users.manage')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : seeOther('/admin/users?error=forbidden');
  }

  const assignRoles = engr.perms.includes('roles.manage');

  // readBody collapses duplicate keys, so parse role_ids directly to keep every
  // selected role rather than only the last one.
  const ct = request.headers.get('content-type') ?? '';
  let scalar: Record<string, unknown> = {};
  let roleIds: string[] = [];
  if (ct.includes('application/json')) {
    const j = (await request.json()) as Record<string, unknown>;
    scalar = j;
    roleIds = Array.isArray(j.role_ids) ? j.role_ids.map(String) : [];
  } else {
    const form = await request.formData();
    for (const [k, v] of form.entries()) scalar[k] = v;
    roleIds = form.getAll('role_ids').map(String).filter(Boolean);
  }

  const id = str(scalar.id).trim();
  const password = str(scalar.password).trim() || null;
  // A new account with no password is invited to set one; otherwise active.
  const defaultStatus = !id && !password ? 'INVITED' : 'ACTIVE';
  const input: UserInput = {
    fullName: str(scalar.full_name).trim(),
    email: str(scalar.email).trim().toLowerCase(),
    phone: str(scalar.phone).trim() || null,
    status: str(scalar.status).trim() || defaultStatus,
    password,
    roleIds: assignRoles ? roleIds : [],
    assignRoles,
  };

  const db = await getDb(getEngrEnv());
  const ctx = { orgId: engr.orgId, userId: engr.userId };
  const result = id ? await updateUser(db, ctx, id, input) : await createUser(db, ctx, input);

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, id ? 200 : 201)
      : seeOther('/admin/users?saved=1');
  }
  const status = result.code === 'conflict' ? 409 : result.code === 'not_found' ? 404 : 422;
  if (wantsJson(request)) {
    return jsonResponse({ ok: false, error: result.code, message: result.message }, status);
  }
  return seeOther(`/admin/users/${id || 'new'}?error=${result.code}`);
};
