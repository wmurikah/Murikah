export const prerender = false;

/**
 * Login endpoint. Email is unique per organisation, so the tenant is resolved by
 * slug first, then the user is looked up within that org. Any failure returns
 * the same generic error, so it never reveals whether the org, the email or the
 * password was wrong. On success it sets the session cookie and redirects to the
 * dashboard, and stamps last_login_at without blocking the response.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { resolveOrgBySlug } from '@engr/tenancy';
import { verifyPassword } from '@engr/auth/password';
import { loadUserAuth } from '@engr/auth/rbac';
import { createSession } from '@engr/auth/session';

interface Credentials {
  org: string;
  email: string;
  password: string;
}

async function readCredentials(request: Request): Promise<Credentials> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await request.json()) as Record<string, unknown>;
    return {
      org: String(body.org ?? ''),
      email: String(body.email ?? ''),
      password: String(body.password ?? ''),
    };
  }
  const form = await request.formData();
  return {
    org: String(form.get('org') ?? ''),
    email: String(form.get('email') ?? ''),
    password: String(form.get('password') ?? ''),
  };
}

// One generic outcome for every failure path.
function invalid(): Response {
  return new Response(null, { status: 303, headers: { location: '/login?error=1' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const { org, email, password } = await readCredentials(request);
  const slug = org.trim().toLowerCase();
  const emailNorm = email.trim().toLowerCase();
  if (!slug || !emailNorm || !password) return invalid();

  const env = getEngrEnv();
  const db = await getDb(env);

  const organisation = await resolveOrgBySlug(db, slug);
  if (!organisation || organisation.status !== 'ACTIVE') return invalid();

  const res = await db.execute({
    sql: `SELECT id, full_name, password_hash, status FROM users
           WHERE org_id = ? AND email = ? AND deleted_at IS NULL LIMIT 1`,
    args: [organisation.id, emailNorm],
  });
  const row = res.rows[0];
  if (!row) return invalid();

  const userId = String(row.id);
  const userName = row.full_name === null ? undefined : String(row.full_name);
  const storedHash = row.password_hash === null ? '' : String(row.password_hash);
  if (String(row.status) !== 'ACTIVE' || !storedHash) return invalid();

  const ok = await verifyPassword(password, storedHash);
  if (!ok) return invalid();

  const { roles, perms } = await loadUserAuth(db, organisation.id, userId);
  // Secure in production (https); off for http development on engr.localhost.
  const secure = new URL(request.url).protocol === 'https:';
  const cookie = await createSession(
    {
      sub: userId,
      org: organisation.id,
      orgSlug: organisation.slug,
      orgName: organisation.name,
      userName,
      userEmail: emailNorm,
      roles,
      perms,
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
      args: [new Date().toISOString(), userId, organisation.id],
    })
    .then(() => undefined)
    .catch(() => undefined);
  locals.cfContext?.waitUntil(pending);

  return new Response(null, {
    status: 303,
    headers: { location: '/', 'set-cookie': cookie },
  });
};
