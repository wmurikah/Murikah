export const prerender = false;

/**
 * Save a role's permission matrix for one organisation, gated on the matrix
 * itself (CONFIG update), platform owner always. Reads every module and action
 * grant off the submitted checkboxes and writes the role's whole matrix in one
 * atomic batch, never touching SUPER_ADMIN (which always holds the full matrix),
 * and records the change in audit_log.
 *
 * The organisation written is the acting one, resolved server-side from the
 * session in `src/middleware.ts` and never taken from the request (Build Prompt
 * 44). An instance admin is pinned to their own organisation and cannot switch,
 * so a save by one customer's administrator can only reach that customer's rows.
 * A platform owner inside an instance edits that instance, exactly as its own
 * administrator would; a platform owner inside no instance edits the platform
 * defaults, which is the one path that writes the sentinel organisation and is
 * why this endpoint is instance-free (`src/lib/grc/routing.ts`).
 *
 * The write is wrapped, and the wrapping is the point: an unhandled throw here
 * used to escape into the middleware's last-resort boundary and reach the
 * administrator as `{"error":"internal_error"}` with the real cause visible only
 * in the Worker log (audit finding AC-03). A Setup mutation must never reach
 * that boundary. The cause is logged under `[grc.access-control]` and the
 * administrator is redirected back to the screen with something they can act on,
 * exactly as the other Setup endpoints behave.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { MODULES, ACTIONS, can, PLATFORM_DEFAULT_ORG } from '@grc/auth/rbac';
import { saveRoleMatrix, type RoleGrant } from '@grc/repos/permissionsAdmin';
import { writeAuditLog } from '@grc/repos/audit';

const TAG = '[grc.access-control]';

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

/** Back to the screen with the role still selected, carrying a message. */
function back(roleCode: string, param: 'done' | 'error', message: string): Response {
  return redirect(
    `/settings/access-control?role=${encodeURIComponent(roleCode)}&${param}=${encodeURIComponent(message)}`,
  );
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
    return back(roleCode, 'error', 'SUPER_ADMIN always has full access and cannot be changed.');
  }

  // The submission is the complete matrix the administrator saw: an unticked box
  // posts nothing, so every cell is read explicitly and stored either way.
  const grants: RoleGrant[] = [];
  for (const moduleCode of MODULES) {
    for (const actionCode of ACTIONS) {
      grants.push({
        moduleCode,
        actionCode,
        isAllowed: form.get(`grant_${moduleCode}_${actionCode}`) === '1',
      });
    }
  }

  // The one organisation this save may reach. An acting organisation is always
  // present for anybody but a platform owner above the instances, and only that
  // owner can therefore reach the platform defaults.
  const targetOrg = grc.organizationId === '' ? PLATFORM_DEFAULT_ORG : grc.organizationId;
  if (targetOrg === PLATFORM_DEFAULT_ORG && !grc.isPlatformOwner) {
    return back(roleCode, 'error', 'Only the platform owner can change the platform defaults.');
  }
  const scopeName =
    targetOrg === PLATFORM_DEFAULT_ORG ? 'the platform defaults' : grc.organizationName;

  const db = await getDb(getGrcEnv());
  try {
    await saveRoleMatrix(db, targetOrg, roleCode, grants);
  } catch (err) {
    console.error(`${TAG} the permissions for ${roleCode} in ${targetOrg} could not be saved`, err);
    return back(
      roleCode,
      'error',
      `The permissions for ${roleCode} could not be saved, so nothing was changed. Please try again.`,
    );
  }

  try {
    await writeAuditLog(db, {
      organizationId: targetOrg,
      userId: grc.userId,
      action: 'ACCESS_CONTROL.update',
      details: `${roleCode} in ${targetOrg}`,
    });
  } catch {
    // best-effort audit
  }

  return back(roleCode, 'done', `Permissions for ${roleCode} saved for ${scopeName}.`);
};
