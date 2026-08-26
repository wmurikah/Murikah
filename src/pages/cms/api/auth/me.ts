/**
 * GET /api/auth/me on cms.murikah.com.
 *
 * Returns the signed-in identity: who they are, where they sit in the
 * organisation, which access roles they hold, the data scopes on those roles,
 * and the resolved permission codes.
 *
 * Access roles and permissions only. Workflow roles and approval authority are
 * a different question in this schema and are not read here.
 *
 * Every field is named. No database row is spread into this body, which is why
 * `password_hash`, `refresh_token_hash` and an MFA secret cannot appear in it
 * even by accident.
 */
import type { APIRoute } from 'astro';
import { json, clientIp } from '@/lib/http';
import { getCmsEnv } from '@/lib/cms/env';
import { getDb } from '@/lib/cms/db';
import { readSessionCookie } from '@/lib/cms/auth/cookie';
import { resolveSession } from '@/lib/cms/auth/loginFlow';
import { apiError, newTraceId } from '@/lib/cms/errors';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  let env: ReturnType<typeof getCmsEnv>;
  try {
    env = getCmsEnv();
  } catch {
    return apiError('unavailable', 'This service is unavailable.', 503, newTraceId());
  }

  try {
    const db = await getDb(env);
    const resolution = await resolveSession(
      db,
      env.sessionSecret,
      readSessionCookie(request),
      new Date(),
    );
    if (resolution.kind === 'anonymous') {
      return apiError('unauthorised', 'Sign in to continue.', 401);
    }

    const id = resolution.identity;
    return json({
      user: {
        userId: id.userId,
        firstName: id.firstName,
        lastName: id.lastName,
        displayName: id.displayName,
        email: id.email,
        userType: id.userType,
        locale: id.locale,
        timezone: id.timezone,
      },
      assignment: id.assignment,
      roles: id.roles,
      scopes: id.scopes,
      permissions: id.permissions,
      // Only meaningful for an EXTERNAL user; empty for staff.
      portalMemberships: id.portalMemberships,
    });
  } catch (error) {
    const traceId = newTraceId();
    console.error(`[cms.me] ${traceId}`, clientIp(request), error);
    return apiError('server_error', 'This service is temporarily unavailable.', 500, traceId);
  }
};

export const ALL: APIRoute = () => apiError('method_not_allowed', 'Use GET.', 405);
