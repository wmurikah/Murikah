export const prerender = false;

/**
 * Roles write endpoint for the acting organisation. Two actions: create a custom
 * role, or save a role's permission set. Only a super-admin with roles.manage
 * may write. Saving a shared default's permissions clones it into this
 * organisation first (copy-on-write, handled in the repo), so the shared role is
 * never mutated. The organisation is always the acting organisation from the
 * session, never a client value.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createCustomRole, saveRolePermissions } from '@engr/repos/adminRoles';
import { jsonResponse, wantsJson, str } from '@engr/workflow/respond';

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('roles.manage')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : seeOther('/admin/roles?error=forbidden');
  }

  const form = await request.formData();
  const action = str(form.get('action')).trim();
  const db = await getDb(getEngrEnv());
  const ctx = { orgId: engr.orgId, userId: engr.userId };

  if (action === 'create') {
    const result = await createCustomRole(db, ctx, {
      code: str(form.get('code')),
      name: str(form.get('name')),
      description: str(form.get('description')) || null,
    });
    if (result.ok) {
      return wantsJson(request)
        ? jsonResponse({ ok: true, id: result.id }, 201)
        : seeOther(`/admin/roles/${result.id}?saved=1`);
    }
    const status = result.code === 'conflict' ? 409 : 422;
    return wantsJson(request)
      ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
      : seeOther(`/admin/roles/new?error=${result.code}`);
  }

  // Save a role's permissions (the default action).
  const roleId = str(form.get('role_id')).trim();
  if (!roleId) {
    return wantsJson(request)
      ? jsonResponse({ error: 'invalid' }, 422)
      : seeOther('/admin/roles?error=invalid');
  }
  const permissionKeys = form.getAll('perm').map((v) => String(v));
  const result = await saveRolePermissions(db, ctx, roleId, permissionKeys);
  if (result.ok) {
    // The id may differ from roleId when a shared role was cloned; land on the
    // role the organisation now owns.
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, 200)
      : seeOther(`/admin/roles/${result.id}?saved=1`);
  }
  const status = result.code === 'not_found' ? 404 : 422;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : seeOther(`/admin/roles/${roleId}?error=${result.code}`);
};
