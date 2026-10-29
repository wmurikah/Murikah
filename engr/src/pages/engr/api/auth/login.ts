export const prerender = false;

/**
 * Login endpoint. Email is globally unique, so the user is resolved by email
 * across the whole system and then placed in their home organisation
 * (users.org_id); there is no organisation slug. Any failure returns the same
 * generic error, so it never reveals whether the email or the password was
 * wrong. On success it sets the session cookie and redirects to the dashboard,
 * and stamps last_login_at without blocking the response.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { verifyPassword } from '@engr/auth/password';
import { loadUserAuth } from '@engr/auth/rbac';
import { createSession } from '@engr/auth/session';

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
function invalid(): Response {
  return new Response(null, { status: 303, headers: { location: '/login?error=1' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const { email, password } = await readCredentials(request);
  const emailNorm = email.trim().toLowerCase();
  if (!emailNorm || !password) return invalid();

  const env = getEngrEnv();
  const db = await getDb(env);

  // Resolve the user by their globally unique email, joining their home
  // organisation in the same query. The domain is never used to pick the org:
  // affiliates may share a domain, so the full email is the identity.
  const res = await db.execute({
    sql: `SELECT u.id AS user_id, u.full_name, u.password_hash, u.status AS user_status,
                 o.id AS org_id, o.slug AS org_slug, o.name AS org_name, o.status AS org_status
            FROM users u
            JOIN organisations o ON o.id = u.org_id
           WHERE u.email = ? AND u.deleted_at IS NULL AND o.deleted_at IS NULL
           LIMIT 1`,
    args: [emailNorm],
  });
  const row = res.rows[0];
  if (!row) return invalid();

  const userId = String(row.user_id);
  const orgId = String(row.org_id);
  const orgSlug = String(row.org_slug);
  const orgName = String(row.org_name);
  const userName = row.full_name === null ? undefined : String(row.full_name);
  const storedHash = row.password_hash === null ? '' : String(row.password_hash);
  if (String(row.user_status) !== 'ACTIVE' || String(row.org_status) !== 'ACTIVE' || !storedHash) {
    return invalid();
  }

  const ok = await verifyPassword(password, storedHash);
  if (!ok) return invalid();

  // Platform ownership decides whether the switcher appears. The column is
  // applied by an operator migration, so read it defensively: an environment
  // without it simply yields an ordinary (non-platform) user.
  let isPlatformOwner = false;
  try {
    const flag = await db.execute({
      sql: `SELECT is_platform_owner FROM users WHERE id = ? LIMIT 1`,
      args: [userId],
    });
    isPlatformOwner = Number(flag.rows[0]?.is_platform_owner ?? 0) === 1;
  } catch {
    isPlatformOwner = false;
  }

  const { roles, perms } = await loadUserAuth(db, orgId, userId);
  // Secure in production (https); off for http development on engr.localhost.
  const secure = new URL(request.url).protocol === 'https:';
  const cookie = await createSession(
    {
      sub: userId,
      org: orgId,
      orgSlug,
      orgName,
      userName,
      userEmail: emailNorm,
      roles,
      perms,
      isPlatformOwner,
    },
    env.sessionSecret,
    secure,
  );

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
    headers: { location: '/', 'set-cookie': cookie },
  });
};
