export const prerender = false;

/**
 * Login endpoint. Email is globally unique, so the user is resolved by email
 * across the whole system and then placed in their home organisation
 * (users.org_id); there is no organisation slug. Any failure returns the same
 * generic error, so it never reveals whether the email or the password was
 * wrong. A user holding a temporary password receives a restricted ten-minute
 * session which can only change that password or log out. Every other user is
 * sent to the dashboard with a full session.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { hashPassword, passwordNeedsRehash, verifyPassword } from '@engr/auth/password';
import { createTrackedSession } from '@engr/auth/trackedSession';
import { sessionAfterPrimaryAuth } from '@engr/auth/loginSession';
import {
  isLoginBlocked,
  loginKeys,
  recordLoginBlocked,
  recordLoginFailure,
  recordLoginSuccess,
} from '@engr/auth/loginSecurity';

interface Credentials {
  email: string;
  password: string;
}

async function readCredentials(request: Request): Promise<Credentials> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await request.json()) as Record<string, unknown>;
    return {
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
    };
  }
  const form = await request.formData();
  return {
    email: String(form.get('email') ?? ''),
    password: String(form.get('password') ?? ''),
  };
}

// One generic outcome for every failure path.
function invalid(limited = false): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: limited ? '/login?error=limited' : '/login?error=1',
      'cache-control': 'no-store',
    },
  });
}

/** A form endpoint can be revisited with GET when a browser restores a tab,
 * refreshes its last URL, or a password manager opens the saved action URL.
 * Never strand that user on Astro's endpoint 404 page. */
export const GET: APIRoute = async () =>
  new Response(null, {
    status: 303,
    headers: { location: '/login', 'cache-control': 'no-store' },
  });

const handleLogin: APIRoute = async ({ request, locals }) => {
  const { email, password } = await readCredentials(request);
  const emailNorm = email.trim().toLowerCase();
  if (!emailNorm || !password) return invalid();

  const env = getEngrEnv();
  const db = await getDb(env);
  const keys = await loginKeys(emailNorm, request);
  if (await isLoginBlocked(db, keys.accountHash, keys.ipHash)) {
    await recordLoginBlocked(db, keys);
    return invalid(true);
  }

  // Resolve the user by their globally unique email, joining their home
  // organisation in the same query. The domain is never used to pick the org:
  // affiliates may share a domain, so the full email is the identity.
  const res = await db.execute({
    sql: `SELECT u.id AS user_id, u.full_name, u.password_hash, u.status AS user_status,
                 u.must_change_password, u.session_version, u.is_platform_owner,
                 o.id AS org_id, o.slug AS org_slug, o.name AS org_name, o.status AS org_status
            FROM users u
            JOIN organisations o ON o.id = u.org_id
           WHERE u.email = ? AND u.deleted_at IS NULL AND o.deleted_at IS NULL
           LIMIT 1`,
    args: [emailNorm],
  });
  const row = res.rows[0];
  if (!row) {
    await recordLoginFailure(db, keys);
    return invalid();
  }

  const userId = String(row.user_id);
  const orgId = String(row.org_id);
  const orgSlug = String(row.org_slug);
  const orgName = String(row.org_name);
  const userName = row.full_name === null ? undefined : String(row.full_name);
  const storedHash = row.password_hash === null ? '' : String(row.password_hash);
  if (String(row.user_status) !== 'ACTIVE' || String(row.org_status) !== 'ACTIVE' || !storedHash) {
    await recordLoginFailure(db, keys, { userId, orgId });
    return invalid();
  }

  const ok = await verifyPassword(password, storedHash);
  if (!ok) {
    await recordLoginFailure(db, keys, { userId, orgId });
    return invalid();
  }
  await recordLoginSuccess(db, keys, { userId, orgId });
  if (passwordNeedsRehash(storedHash)) {
    const replacement = await hashPassword(password);
    await db.execute({
      sql: `UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?`,
      args: [replacement, userId, storedHash],
    });
    await db.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id)
            VALUES (?, ?, 'auth.password.rehashed', 'user', ?)`,
      args: [orgId, userId, userId],
    });
  }

  const isPlatformOwner = Number(row.is_platform_owner ?? 0) === 1;
  const sessionVersion = Number(row.session_version ?? 0);
  const passwordChangeOnly = Number(row.must_change_password ?? 0) === 1;
  // Secure in production (https); off for http development on engr.localhost.
  const secure = new URL(request.url).protocol === 'https:';
  const identity = {
    userId,
    orgId,
    orgSlug,
    orgName,
    userName,
    userEmail: emailNorm,
    isPlatformOwner,
    sessionVersion,
  };
  const next = passwordChangeOnly
    ? {
        cookie: await createTrackedSession(
          db,
          {
            sub: userId,
            org: orgId,
            orgSlug,
            orgName,
            userName,
            userEmail: emailNorm,
            roles: [],
            perms: [],
            isPlatformOwner,
            sessionVersion,
            authStage: 'password-change',
          },
          env.sessionSecret,
          secure,
          request,
        ),
        location: '/change-password',
      }
    : await sessionAfterPrimaryAuth(db, identity, env.sessionSecret, secure, request);

  // Stamp last_login_at without blocking the redirect. waitUntil keeps the
  // write alive after the response in the Worker; if it is unavailable the
  // promise is simply left running.
  const pending = db
    .execute({
      sql: `UPDATE users SET last_login_at = ? WHERE id = ? AND org_id = ?`,
      args: [new Date().toISOString(), userId, orgId],
    })
    .then(() => undefined)
    .catch(() => undefined);
  locals.cfContext?.waitUntil(pending);

  return new Response(null, {
    status: 303,
    headers: { location: next.location, 'set-cookie': next.cookie },
  });
};

/** Keep infrastructure or rollout faults out of the browser's raw Worker 500
 * page. The response remains deliberately generic; the detailed failure is
 * available to operators in Worker logs. */
export const POST: APIRoute = async (context) => {
  try {
    return await handleLogin(context);
  } catch (error) {
    console.error('[engr.auth.login] sign-in unavailable', error);
    return new Response(null, {
      status: 303,
      headers: { location: '/login?error=unavailable', 'cache-control': 'no-store' },
    });
  }
};
