export const prerender = false;

/**
 * Change the sign-in verification method (Build Prompt 37). The
 * authenticator app is an admin-only alternative: only roles allowed by
 * MFA_AUTHENTICATOR_ROLES (the platform owner always qualifies) may start
 * the TOTP enrolment, which generates a fresh sealed secret and eight sealed
 * backup codes and stores the pending record; the active factor keeps
 * working until a first app code confirms it. Switching back to email codes
 * is immediate: email is the universal, enrolment-free default, so the
 * record flips straight over, keeping the unused backup codes. Replacing the
 * same method's factor stays an administrative reset. Tagged [grc.auth.mfa];
 * never a blank 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { generateSecret } from '@grc/auth/totp';
import { seal } from '@grc/auth/secretBox';
import { startEnrolment, switchToEmail, generateBackupCodes, type MfaMethod } from '@grc/repos/mfa';
import { authenticatorAllowedForRole, MFA_AUTHENTICATOR_ROLES_KEY } from '@grc/auth/mfaPolicy';
import { getConfigValues } from '@grc/repos/orgConfig';
import { recordSecurityEvent } from '@grc/repos/loginAttempts';

const TAG = '[grc.auth.mfa]';
const PAGE = '/mfa/setup';
const back = (q: string): Response =>
  new Response(null, { status: 303, headers: { location: `${PAGE}?${q}` } });
const fail = (message: string): Response => back(`error=${encodeURIComponent(message)}`);

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  try {
    const env = getGrcEnv();
    const db = await getDb(env);
    const form = await request.formData().catch(() => new FormData());
    const rawMethod = String(form.get('method') ?? 'totp');
    const method: MfaMethod = rawMethod === 'email' ? 'email' : 'totp';
    const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for');

    if (method === 'email') {
      await switchToEmail(db, grc.homeOrganizationId, grc.userId);
      await recordSecurityEvent(db, {
        eventType: 'MFA_METHOD_CHANGED',
        severity: 'info',
        userId: grc.userId,
        actorEmail: grc.userEmail ?? null,
        ip,
        details: 'Sign-in verification switched to email codes.',
      }).catch(() => undefined);
      return back('email=1');
    }

    const rule = await getConfigValues(db, grc.homeOrganizationId, [MFA_AUTHENTICATOR_ROLES_KEY]);
    const allowed =
      grc.isPlatformOwner ||
      authenticatorAllowedForRole(grc.roleCode, rule.get(MFA_AUTHENTICATOR_ROLES_KEY));
    if (!allowed) {
      return fail(
        'The authenticator app is available to administrator roles only. Your account signs in with email codes.',
      );
    }

    const codes = generateBackupCodes();
    const sealedCodes = await seal(env.sessionSecret, JSON.stringify(codes));
    const sealedSecret = await seal(env.sessionSecret, generateSecret());

    const started = await startEnrolment(
      db,
      grc.homeOrganizationId,
      grc.userId,
      method,
      sealedSecret,
      sealedCodes,
    );
    if (!started) {
      return fail(
        'The authenticator app is already your method. Replacing it needs an administrator reset.',
      );
    }
    return new Response(null, { status: 303, headers: { location: PAGE } });
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return fail('The change could not be started just now. Please try again.');
  }
};
