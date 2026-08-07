export const prerender = false;

/**
 * Save a role's permission matrix, gated on the matrix itself (CONFIG update),
 * platform owner always. The whole submission is written in one atomic
 * `db.batch(..., 'write')` and the change is recorded in audit_log.
 *
 * Build Prompt 43 (AC-03). This used to loop nine modules by six actions,
 * issuing an UPDATE and often an INSERT per cell: up to 108 sequential HTTPS
 * round trips from a Worker, no transaction, and no error handling. When a write
 * failed part-way the administrator saw the middleware's `internal_error` while
 * three quarters of the change was already live, in a state they never chose and
 * could not see. It is now one batch that either applies entirely or not at all,
 * and a failure is logged under `[grc.access-control]` and returned to the screen
 * as a banner the administrator can act on, exactly as the other Setup endpoints
 * behave. No Setup mutation reaches the middleware's last-resort boundary.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { MODULES, ACTIONS, can } from '@grc/auth/rbac';
import { saveRoleMatrix, type GrantInput } from '@grc/repos/permissionsAdmin';
import { writeAuditLog } from '@grc/repos/audit';

const TAG = '[grc.access-control]';
const PAGE = '/settings/access-control';

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function back(roleCode: string, param: string, message: string): Response {
  const role = roleCode ? `role=${encodeURIComponent(roleCode)}&` : '';
  return redirect(`${PAGE}?${role}${param}=${encodeURIComponent(message)}`);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return redirect('/login');
  if (!grc.isPlatformOwner && !can(locals, 'update', 'CONFIG')) {
    return new Response('Forbidden', { status: 403 });
  }

  const form = await request.formData();
  const roleCode = String(form.get('role_code') ?? '').trim();
  if (!roleCode) return back('', 'error', 'No role was specified.');
  // SUPER_ADMIN always holds the full matrix and is never modified here.
  if (roleCode === 'SUPER_ADMIN') {
    return back(roleCode, 'error', 'SUPER_ADMIN always has full access and cannot be changed.');
  }

  // The screen submits every cell, so the submission is the role's whole matrix.
  const grants: GrantInput[] = [];
  for (const module of MODULES) {
    for (const action of ACTIONS) {
      grants.push({
        moduleCode: module,
        actionCode: action,
        isAllowed: form.get(`grant_${module}_${action}`) === '1',
      });
    }
  }

  const db = await getDb(getGrcEnv());
  try {
    await saveRoleMatrix(db, roleCode, grants);
  } catch (err) {
    console.error(`${TAG} the permission matrix for ${roleCode} could not be saved`, err);
    return back(
      roleCode,
      'error',
      'The permissions could not be saved, so nothing was changed. Please try again.',
    );
  }

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

  // No cache to clear: the matrix is read fresh from role_permissions on every
  // request (Build Prompt 43, AC-04), so the change is in force at every edge on
  // the very next request rather than whenever an isolate happened to recycle.
  return back(roleCode, 'done', 'Permissions saved.');
};
