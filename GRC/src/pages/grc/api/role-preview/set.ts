export const prerender = false;

import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { createRolePreviewCookie } from '@grc/auth/rolePreview';
import { resolveRolePreview } from '@grc/repos/rolePreview';
import { safeNextPath } from '@grc/routing';
import { writeAuditLog } from '@grc/repos/audit';

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc?.canRolePreview || !grc.instanceSelected) {
    return new Response('Forbidden', { status: 403 });
  }
  const form = await request.formData();
  const requested = {
    roleCode: String(form.get('role_code') ?? '').trim(),
    affiliateCode: String(form.get('affiliate_code') ?? '').trim() || null,
  };
  const env = getGrcEnv();
  const db = await getDb(env);
  const preview = await resolveRolePreview(db, grc.organizationId, requested);
  const next = safeNextPath(String(form.get('next') ?? '')) ?? '/';
  if (!preview) {
    return new Response(null, {
      status: 303,
      headers: { location: `${next}?preview_error=invalid` },
    });
  }
  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'ROLE_PREVIEW.start',
      entityType: 'role',
      entityId: preview.roleCode,
      details: `Read-only preview${preview.affiliateCode ? ` for ${preview.affiliateCode}` : ''}`,
    });
  } catch (error) {
    console.error('[grc.role-preview.audit.start]', error);
  }
  const secure = new URL(request.url).protocol === 'https:';
  const cookie = await createRolePreviewCookie(preview, env.sessionSecret, secure);
  return new Response(null, { status: 303, headers: { location: next, 'set-cookie': cookie } });
};
