export const prerender = false;

/**
 * Save a role's permission matrix, gated on the matrix itself (CONFIG update),
 * platform owner always. Never touches SUPER_ADMIN, which always holds the full
 * matrix.
 *
 * The whole submission goes down as one atomic batch (Build Prompt 43). It used
 * to be 54 sequential UPDATE-then-INSERT round trips with nothing around them,
 * which meant two things: a failure part way through left the role three
 * quarters changed while telling the administrator the save had failed, and the
 * throw escaped to the middleware's last-resort boundary, so all they ever saw
 * was `{"error":"internal_error"}`. Now it applies in full or not at all, and a
 * failure comes back to the screen as a message with the cause logged under
 * [grc.access-control], the way every other Setup endpoint behaves.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { MODULES, ACTIONS, can } from '@grc/auth/rbac';
import { saveRoleMatrix, type Grant } from '@grc/repos/permissionsAdmin';
import { writeAuditLog } from '@grc/repos/audit';

const TAG = '[grc.access-control]';
const PAGE = '/settings/access-control';

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

/** Back to the screen with the role still selected, carrying a message. */
function back(roleCode: string, kind: 'done' | 'error', message: string): Response {
  const role = roleCode ? `role=${encodeURIComponent(roleCode)}&` : '';
  return redirect(`${PAGE}?${role}${kind}=${encodeURIComponent(message)}`);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return redirect('/login');
  if (!grc.isPlatformOwner && !can(locals, 'update', 'CONFIG')) {
    return new Response('Forbidden', { status: 403 });
  }

  const form = await request.formData();
  const roleCode = String(form.get('role_code') ?? '').trim();
  if (!roleCode) return back('', 'error', 'No role was selected.');
  // SUPER_ADMIN always holds the full matrix and is never modified here.
  if (roleCode === 'SUPER_ADMIN') {
    return back(
      'SUPER_ADMIN',
      'error',
      'SUPER_ADMIN always has full access and cannot be changed.',
    );
  }

  const grants: Grant[] = [];
  for (const moduleCode of MODULES) {
    for (const actionCode of ACTIONS) {
      grants.push({
        moduleCode,
        actionCode,
        isAllowed: form.get(`grant_${moduleCode}_${actionCode}`) === '1',
      });
    }
  }

  try {
    const db = await getDb(getGrcEnv());
    // One atomic batch: the role's matrix is replaced in full, or not at all.
    await saveRoleMatrix(db, roleCode, grants);
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
    return back(roleCode, 'done', `Permissions saved for ${roleCode}.`);
  } catch (err) {
    // Never a silent 500 from the boundary: the cause goes to the log and the
    // administrator gets something they can act on.
    console.error(`${TAG} saving the matrix for ${roleCode} failed`, err);
    return back(
      roleCode,
      'error',
      'The permissions could not be saved. Nothing was changed. Please try again, and contact support if it keeps happening.',
    );
  }
};
