export const prerender = false;

/** Complete a forced or voluntary password change. The caller must prove the
 * existing password. The password update, session-generation increment and
 * audit record commit atomically; no password is written to audit data. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { hashPassword, validatePasswordSecurity, verifyPassword } from '@engr/auth/password';
import { clearSession, readSession } from '@engr/auth/session';
import { sessionAfterPrimaryAuth } from '@engr/auth/loginSession';

function redirect(location: string, cookie?: string): Response {
  const headers: Record<string, string> = { location };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status: 303, headers });
}

export const POST: APIRoute = async ({ request }) => {
  const env = getEngrEnv();
  const secure = new URL(request.url).protocol === 'https:';
  const session = await readSession(request, env.sessionSecret);
  if (!session) return redirect('/login', clearSession(secure));

  const form = await request.formData();
  const currentPassword = String(form.get('current_password') ?? '');
  const newPassword = String(form.get('new_password') ?? '');
  const confirmation = String(form.get('confirm_password') ?? '');
  if (newPassword !== confirmation) return redirect('/change-password?error=mismatch');
  if (await validatePasswordSecurity(newPassword)) return redirect('/change-password?error=policy');

  const db = await getDb(env);
  const result = await db.execute({
    sql: `SELECT u.password_hash, u.must_change_password, u.session_version,
                 u.full_name, u.email, u.status AS user_status, u.is_platform_owner,
                 o.slug AS org_slug, o.name AS org_name, o.status AS org_status
            FROM users u
            JOIN organisations o ON o.id = u.org_id
           WHERE u.id = ? AND u.org_id = ? AND u.deleted_at IS NULL AND o.deleted_at IS NULL
           LIMIT 1`,
    args: [session.sub, session.org],
  });
  const user = result.rows[0];
  const storedHash = user?.password_hash === null ? '' : String(user?.password_hash ?? '');
  const version = Number(user?.session_version ?? -1);
  if (
    !user ||
    String(user.user_status) !== 'ACTIVE' ||
    String(user.org_status) !== 'ACTIVE' ||
    version !== (session.sessionVersion ?? 0)
  ) {
    return redirect('/login', clearSession(secure));
  }
  if (!storedHash || !(await verifyPassword(currentPassword, storedHash))) {
    return redirect('/change-password?error=current');
  }
  if (await verifyPassword(newPassword, storedHash)) {
    return redirect('/change-password?error=same');
  }

  const nextHash = await hashPassword(newPassword);
  const nextVersion = version + 1;
  const wasForced = Number(user.must_change_password ?? 0) === 1;
  const tx = await db.transaction('write');
  try {
    const updated = await tx.execute({
      sql: `UPDATE users
               SET password_hash = ?, must_change_password = 0,
                   session_version = session_version + 1
             WHERE id = ? AND org_id = ? AND session_version = ? AND deleted_at IS NULL`,
      args: [nextHash, session.sub, session.org, version],
    });
    if (updated.rowsAffected !== 1) throw new Error('The session changed during password update.');
    await tx.execute({
      sql: `UPDATE auth_sessions SET revoked_at = ?, revoked_reason = 'password changed'
             WHERE user_id = ? AND revoked_at IS NULL`,
      args: [new Date().toISOString(), session.sub],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs
              (org_id, actor_user_id, action, entity_type, entity_id, after_json, ip, user_agent)
            VALUES (?, ?, 'users.password.change', 'user', ?, ?, ?, ?)`,
      args: [
        session.org,
        session.sub,
        session.sub,
        JSON.stringify({ forced: wasForced, sessions_revoked: true }),
        request.headers.get('cf-connecting-ip'),
        request.headers.get('user-agent'),
      ],
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }

  const next = await sessionAfterPrimaryAuth(
    db,
    {
      userId: session.sub,
      orgId: session.org,
      orgSlug: String(user.org_slug),
      orgName: String(user.org_name),
      userName: String(user.full_name),
      userEmail: String(user.email),
      isPlatformOwner: Number(user.is_platform_owner ?? 0) === 1,
      sessionVersion: nextVersion,
    },
    env.sessionSecret,
    secure,
    request,
  );
  return redirect(next.location, next.cookie);
};
