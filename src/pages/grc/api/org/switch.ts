export const prerender = false;

/**
 * Enter an instance. Only a platform owner may select one, and only from the set
 * of active organisations on the platform; the choice is validated server-side
 * here and re-validated by the middleware on every subsequent request, so a
 * tampered cookie can never widen access. An id outside the set is refused back
 * to the all-instances view, never quietly resolved to the owner's home
 * organisation. Entering is recorded in `audit_log`. An instance admin is pinned
 * to their own organisation and this endpoint refuses them.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { resolveActingContext } from '@grc/repos/orgContext';
import { createActingCookie } from '@grc/auth/actingOrg';
import { writeAuditLog } from '@grc/repos/audit';
import { GRC_PLATFORM_PATH } from '@grc/routing';

function toPlatform(error?: string): Response {
  const location = error
    ? `${GRC_PLATFORM_PATH}?error=${encodeURIComponent(error)}`
    : GRC_PLATFORM_PATH;
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  // Only a platform owner selects an instance; everyone else is pinned to theirs.
  if (!grc.isPlatformOwner) return new Response(null, { status: 303, headers: { location: '/' } });

  const form = await request.formData();
  const requested = String(form.get('organization_id') ?? '').trim();
  if (!requested) return toPlatform('Choose an instance to enter.');

  const env = getGrcEnv();
  const db = await getDb(env);

  // Validate the requested organisation is one this owner may enter. An
  // unknown or inactive id resolves to no instance, and is refused.
  const acting = await resolveActingContext(
    db,
    grc.homeOrganizationId,
    grc.organizationName,
    true,
    requested,
  );
  if (!acting.actingOrganizationId) {
    return toPlatform('That instance is not available.');
  }
  const secure = new URL(request.url).protocol === 'https:';
  const cookie = await createActingCookie(acting.actingOrganizationId, env.sessionSecret, secure);

  // Audit the switch, scoped to the organisation being entered. Non-fatal: the
  // switch is the user's own action and must not fail on an audit write.
  try {
    await writeAuditLog(db, {
      organizationId: acting.actingOrganizationId,
      userId: grc.userId,
      action: 'ORG.switch',
      entityType: 'organization',
      entityId: acting.actingOrganizationId,
      details: `Entered instance ${acting.actingName ?? acting.actingOrganizationId}`,
    });
  } catch {
    // Continue: the switch still applies.
  }

  return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': cookie } });
};
