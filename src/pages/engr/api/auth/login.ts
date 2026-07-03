export const prerender = false;

/**
 * Login endpoint. Email alone identifies the user (users.email is globally
 * unique), so there is no organisation field: resolve the user by email across
 * the whole system, verify the password, then place them in their home
 * organisation (users.org_id), which is their instance. From there a platform
 * owner or group super-admin may switch the acting organisation (see the
 * middleware). Any failure returns the same generic error, so it never reveals
 * whether the email exists. On success it sets the session cookie and redirects
 * to the dashboard, and stamps last_login_at without blocking the response.
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
    return { email: String(body.email ?? ''), password: String(body.password ?? '') };
  }
  const form = await request.formData();
  return { email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') };
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

  // The full email is the identity; the domain is not (affiliates may share one).
  const res = await db.execute({
    sql: `SELECT u.id AS id, u.full_name AS full_name, u.password_hash AS password_hash,
                 u.status AS status, u.org_id AS org_id,
                 o.slug AS org_slug, o.name AS org_name, o.status AS org_status
            FROM users u
            JOIN organisations o ON o.id = u.org_id
           WHERE u.email = ? AND u.deleted_at IS NULL AND o.deleted_at IS NULL
           LIMIT 1`,
    args: [emailNorm],
  });
  const row = res.rows[0];
  if (!row) return invalid();

  if (String(row.org_status) !== 'ACTIVE') return invalid();
  const userId = String(row.id);
  const orgId = String(row.org_id);
  const userName = row.full_name === null ? undefined : String(row.full_name);
  const storedHash = row.password_hash === null ? '' : String(row.password_hash);
  if (String(row.status) !== 'ACTIVE' || !storedHash) return invalid();

  const ok = await verifyPassword(password, storedHash);
  if (!ok) return invalid();

  const { roles, perms } = await loadUserAuth(db, orgId, userId);
  const secure = new URL(request.url).protocol === 'https:';
  const cookie = await createSession(
    {
      sub: userId,
      org: orgId,
      orgSlug: String(row.org_slug),
      orgName: String(row.org_name),
      userName,
      userEmail: emailNorm,
      roles,
      perms,
    },
    env.sessionSecret,
    secure,
  );

  // Stamp last_login_at without blocking the redirect.
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
