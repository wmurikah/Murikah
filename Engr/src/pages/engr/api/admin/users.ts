export const prerender = false;

/**
 * Users admin write endpoint. Create when no id is posted, otherwise update.
 * User profile edits, invitations, resets, suspension and role assignment are
 * independently gated. Delegated managers can assign operational roles without
 * receiving the ability to redefine the security policy itself.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createUser, getUser, updateUser, type UserInput } from '@engr/repos/adminUsers';
import { userManagementScope } from '@engr/auth/adminPolicy';
import { jsonResponse, wantsJson, str } from '@engr/workflow/respond';

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const mayManage = engr.perms.includes('users.update');
  const mayInvite = engr.perms.includes('users.invite');
  if (!(mayManage || mayInvite)) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : seeOther('/admin/users?error=forbidden');
  }

  const mayAssignRoles = engr.perms.includes('users.assign_roles');
  const managementScope = userManagementScope(engr.roles, engr.isPlatformOwner);

  // readBody collapses duplicate keys, so parse role_ids directly to keep every
  // selected role rather than only the last one.
  const ct = request.headers.get('content-type') ?? '';
  let scalar: Record<string, unknown> = {};
  let roleIds: string[] = [];
  let roleAssignmentRequested = false;
  if (ct.includes('application/json')) {
    const j = (await request.json()) as Record<string, unknown>;
    scalar = j;
    roleIds = Array.isArray(j.role_ids) ? j.role_ids.map(String) : [];
    roleAssignmentRequested = Object.prototype.hasOwnProperty.call(j, 'role_ids');
  } else {
    const form = await request.formData();
    for (const [k, v] of form.entries()) scalar[k] = v;
    roleIds = form.getAll('role_ids').map(String).filter(Boolean);
    roleAssignmentRequested = form.has('roles_present');
  }

  const id = str(scalar.id).trim();
  if (!id && !mayInvite) return jsonResponse({ error: 'forbidden' }, 403);
  if (id && !mayManage) return jsonResponse({ error: 'forbidden' }, 403);
  if (roleAssignmentRequested && !mayAssignRoles) {
    return jsonResponse({ error: 'forbidden' }, 403);
  }
  // Preserve intentional spaces in passphrases. The repository validates length
  // and rejects an all-space value.
  const passwordValue = str(scalar.password);
  const password = passwordValue.length ? passwordValue : null;
  if (id && password && !engr.perms.includes('users.reset_password')) {
    return jsonResponse({ error: 'forbidden' }, 403);
  }
  const defaultStatus = password ? 'ACTIVE' : 'INVITED';
  const environment = getEngrEnv();
  const input: UserInput = {
    fullName: str(scalar.full_name).trim(),
    email: str(scalar.email).trim().toLowerCase(),
    phone: str(scalar.phone).trim() || null,
    status: str(scalar.status).trim() || defaultStatus,
    password,
    roleIds: mayAssignRoles && roleAssignmentRequested ? roleIds : [],
    assignRoles: mayAssignRoles && roleAssignmentRequested,
    managementScope,
    appOrigin: new URL(request.url).origin,
    authMessageKey: environment.authMessageKey,
  };

  const db = await getDb(environment);
  if (id) {
    const existing = await getUser(db, engr.orgId, id);
    if (!existing) return jsonResponse({ error: 'not_found' }, 404);
    if (existing.status !== input.status && !engr.perms.includes('users.suspend')) {
      return jsonResponse({ error: 'forbidden' }, 403);
    }
  }
  const ctx = { orgId: engr.orgId, userId: engr.userId };
  const result = id ? await updateUser(db, ctx, id, input) : await createUser(db, ctx, input);

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, id ? 200 : 201)
      : seeOther('/admin/users?saved=1');
  }
  const status =
    result.code === 'conflict'
      ? 409
      : result.code === 'not_found'
        ? 404
        : result.code === 'forbidden'
          ? 403
          : 422;
  if (wantsJson(request)) {
    return jsonResponse({ ok: false, error: result.code, message: result.message }, status);
  }
  return seeOther(`/admin/users/${id || 'new'}?error=${result.code}`);
};
