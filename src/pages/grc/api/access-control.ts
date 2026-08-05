export const prerender = false;

/**
 * Save a role's permission matrix, gated on the matrix itself (CONFIG
 * update), platform owner always. Writes each module and
 * action grant to role_permissions from the submitted checkboxes, never touching
 * SUPER_ADMIN (which always holds the full matrix), invalidates the cached matrix
 * so the change takes effect, and records the change in audit_log.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { MODULES, ACTIONS, invalidateRoleMatrix, can } from '@grc/auth/rbac';
import { setGrant } from '@grc/repos/permissionsAdmin';
import { writeAuditLog } from '@grc/repos/audit';

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return redirect('/login');
  if (!grc.isPlatformOwner && !can(locals, 'update', 'CONFIG')) {
    return new Response('Forbidden', { status: 403 });
  }

  const form = await request.formData();
  const roleCode = String(form.get('role_code') ?? '').trim();
  if (!roleCode) return redirect('/settings/access-control?error=invalid');
  // SUPER_ADMIN always holds the full matrix and is never modified here.
  if (roleCode === 'SUPER_ADMIN') {
    return redirect(
      `/settings/access-control?role=${encodeURIComponent(roleCode)}&error=${encodeURIComponent('SUPER_ADMIN always has full access and cannot be changed.')}`,
    );
  }

  const db = await getDb(getGrcEnv());
  for (const module of MODULES) {
    for (const action of ACTIONS) {
      const allowed = form.get(`grant_${module}_${action}`) === '1';
      await setGrant(db, roleCode, module, action, allowed);
    }
  }
  invalidateRoleMatrix(roleCode);
  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'ACCESS_CONTROL.update',
      details: roleCode,
    });
  } catch {
    // best-effort audit
  }

  return redirect(
    `/settings/access-control?role=${encodeURIComponent(roleCode)}&done=${encodeURIComponent('Permissions saved.')}`,
  );
};
