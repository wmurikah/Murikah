export const prerender = false;

/**
 * Leave the current instance and return to the all-instances view. Clearing the
 * acting cookie puts a platform owner back where they signed in: pinned to no
 * organisation, with nothing scoped to a customer. Leaving is recorded in
 * `audit_log` alongside the entering it undoes, so the trail shows both ends of
 * every visit. An instance admin has no instance to leave and is sent home.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { clearActingCookie } from '@grc/auth/actingOrg';
import { writeAuditLog } from '@grc/repos/audit';
import { GRC_PLATFORM_PATH } from '@grc/routing';

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!grc.isPlatformOwner) return new Response(null, { status: 303, headers: { location: '/' } });

  // Audit the instance being left, while it is still the acting one. Non-fatal:
  // the owner's own navigation must not fail on an audit write.
  if (grc.instanceSelected) {
    try {
      const db = await getDb(getGrcEnv());
      await writeAuditLog(db, {
        organizationId: grc.organizationId,
        userId: grc.userId,
        action: 'ORG.leave',
        entityType: 'organization',
        entityId: grc.organizationId,
        details: `Left instance ${grc.organizationName}`,
      });
    } catch {
      // Continue: leaving still applies.
    }
  }

  const secure = new URL(request.url).protocol === 'https:';
  return new Response(null, {
    status: 303,
    headers: { location: GRC_PLATFORM_PATH, 'set-cookie': clearActingCookie(secure) },
  });
};
