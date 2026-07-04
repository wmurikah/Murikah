export const prerender = false;

/**
 * Switch the acting organisation. Only a platform owner may switch, and only to
 * an organisation on the platform; the choice is validated server-side here and
 * re-validated by the middleware on every subsequent request, so a tampered
 * cookie can never widen access. The switch is recorded to `audit_log`. Every
 * other user is fixed to their home organisation and this endpoint refuses.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { resolveActingContext } from '@grc/repos/orgContext';
import { createActingCookie } from '@grc/auth/actingOrg';
import { writeAuditLog } from '@grc/repos/audit';

function back(): Response {
  return new Response(null, { status: 303, headers: { location: '/' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  // Only a platform owner may switch; everyone else is fixed to their home org.
  if (!grc.isPlatformOwner) return back();

  const form = await request.formData();
  const requested = String(form.get('organization_id') ?? '').trim();
  if (!requested) return back();

  const env = getGrcEnv();
  const db = await getDb(env);

  // Validate the requested organisation is in the switchable set for this owner.
  const acting = await resolveActingContext(
    db,
    grc.homeOrganizationId,
    grc.organizationName,
    true,
    requested,
  );
  const secure = new URL(request.url).protocol === 'https:';
  const cookie = await createActingCookie(acting.actingOrganizationId, env.sessionSecret, secure);

  // Audit the switch, scoped to the organisation being entered. Non-fatal: the
  // switch is the user's own action and must not fail on an audit write.
  try {
    await writeAuditLog(db, {
      organizationId: acting.actingOrganizationId,
      userId: grc.userId,
      action: 'ORG.switch',
      details: `Acting organisation set to ${acting.actingOrganizationId}`,
    });
  } catch {
    // Continue: the switch still applies.
  }

  return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': cookie } });
};
