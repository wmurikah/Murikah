export const prerender = false;

import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { clearRolePreviewCookies } from '@grc/auth/rolePreview';
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
  const headers = new Headers({ location: next });
  for (const value of clearRolePreviewCookies(secure)) headers.append('set-cookie', value);
  return new Response(null, {
    status: 303,
    headers,
  });
};
