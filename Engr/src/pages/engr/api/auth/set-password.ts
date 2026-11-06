export const prerender = false;
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { hashPassword, validateNewPassword } from '@engr/auth/password';
import { hashOpaqueToken } from '@engr/auth/tokens';

function back(token: string, error: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/set-password?token=${encodeURIComponent(token)}&error=${error}` },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const token = String(form.get('token') ?? '');
  const password = String(form.get('password') ?? '');
  const confirmation = String(form.get('confirm_password') ?? '');
  if (!token) return back('', 'invalid');
  if (password !== confirmation || validateNewPassword(password)) return back(token, 'password');
  const tokenHash = await hashOpaqueToken(token);
  const db = await getDb(getEngrEnv());
  const tx = await db.transaction('write');
  try {
    const result = await tx.execute({
      sql: `SELECT t.id AS token_id, t.org_id, t.user_id, t.purpose
              FROM auth_tokens t
              JOIN users u ON u.id = t.user_id
             WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ?
               AND u.deleted_at IS NULL AND u.status IN ('INVITED','ACTIVE')
             LIMIT 1`,
      args: [tokenHash, new Date().toISOString()],
    });
    const row = result.rows[0];
    if (!row) {
      await tx.rollback();
      return back(token, 'invalid');
    }
    const used = await tx.execute({
      sql: `UPDATE auth_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`,
      args: [new Date().toISOString(), String(row.token_id)],
    });
    if (used.rowsAffected !== 1) {
      await tx.rollback();
      return back(token, 'invalid');
    }
    const passwordHash = await hashPassword(password);
    await tx.execute({
      sql: `UPDATE users
               SET password_hash = ?, status = 'ACTIVE', must_change_password = 0,
                   session_version = session_version + 1
             WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      args: [passwordHash, String(row.user_id), String(row.org_id)],
    });
    await tx.execute({
      sql: `UPDATE auth_tokens SET used_at = ?
             WHERE user_id = ? AND used_at IS NULL`,
      args: [new Date().toISOString(), String(row.user_id)],
    });
    const action =
      String(row.purpose) === 'INVITE' ? 'auth.invitation.accept' : 'auth.password.recover';
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, ?, 'user', ?, ?)`,
      args: [
        String(row.org_id),
        String(row.user_id),
        action,
        String(row.user_id),
        JSON.stringify({ sessions_revoked: true }),
      ],
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
  return new Response(null, { status: 303, headers: { location: '/login?password=changed' } });
};
