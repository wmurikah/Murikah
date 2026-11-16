export const prerender = false;

import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { clearRolePreviewCookie } from '@grc/auth/rolePreview';
import { safeNextPath } from '@grc/routing';
import { writeAuditLog } from '@grc/repos/audit';

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc?.canRolePreview) return new Response('Forbidden', { status: 403 });
  const form = await request.formData();
  const next = safeNextPath(String(form.get('next') ?? '')) ?? '/';
  if (grc.instanceSelected) {
    try {
      const db = await getDb(getGrcEnv());
      await writeAuditLog(db, {
        organizationId: grc.organizationId,
        userId: grc.userId,
        action: 'ROLE_PREVIEW.end',
        entityType: 'role',
        entityId: grc.rolePreview?.roleCode ?? null,
        details: 'Returned to platform-owner access',
      });
    } catch (error) {
      console.error('[grc.role-preview.audit.end]', error);
    }
  }
  const secure = new URL(request.url).protocol === 'https:';
  return new Response(null, {
    status: 303,
    headers: { location: next, 'set-cookie': clearRolePreviewCookie(secure) },
  });
};
