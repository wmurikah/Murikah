export const prerender = false;
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { readSession } from '@engr/auth/session';
import { encryptMfaSecret, generateTotpSecret, resolveMfaEncryptionKey } from '@engr/auth/mfa';
import { verifyPassword } from '@engr/auth/password';

export const POST: APIRoute = async ({ request }) => {
  const env = getEngrEnv();
  const mfa = resolveMfaEncryptionKey(env.mfaEncryptionKey, '/mfa/enroll?error=config');
  if (!mfa.ok) return mfa.response;
  const session = await readSession(request, env.sessionSecret);
  if (!session) return new Response(null, { status: 303, headers: { location: '/login' } });
  const db = await getDb(env);
  if (session.authStage !== 'mfa-enroll') {
    const form = await request.formData();
    const currentPassword = String(form.get('current_password') ?? '');
    const user = await db.execute({
      sql: `SELECT password_hash FROM users WHERE id = ? AND org_id = ? LIMIT 1`,
      args: [session.sub, session.org],
    });
    const stored = String(user.rows[0]?.password_hash ?? '');
    if (!stored || !(await verifyPassword(currentPassword, stored))) {
      return new Response(null, {
        status: 303,
        headers: { location: '/mfa/enroll?error=password' },
      });
    }
  }
  const existing = await db.execute({
    sql: `SELECT enabled_at FROM user_mfa WHERE user_id = ? LIMIT 1`,
    args: [session.sub],
  });
  if (existing.rows[0]?.enabled_at != null) {
    return new Response(null, { status: 303, headers: { location: '/mfa/enroll' } });
  }
  const secret = generateTotpSecret();
  const encrypted = await encryptMfaSecret(secret, mfa.key);
  const expiry = new Date(Date.now() + 10 * 60_000).toISOString();
  await db.batch(
    [
      {
        sql: `INSERT INTO user_mfa
                (user_id, secret_ciphertext, secret_iv, pending_expires_at, enabled_at, last_totp_step)
              VALUES (?, ?, ?, ?, NULL, NULL)
              ON CONFLICT(user_id) DO UPDATE SET
                secret_ciphertext = excluded.secret_ciphertext,
                secret_iv = excluded.secret_iv,
                pending_expires_at = excluded.pending_expires_at,
                enabled_at = NULL,
                last_totp_step = NULL,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        args: [session.sub, encrypted.ciphertext, encrypted.iv, expiry],
      },
      {
        sql: `INSERT INTO audit_logs
                (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'auth.mfa.enroll.start', 'user', ?, ?)`,
        args: [session.org, session.sub, session.sub, JSON.stringify({ expires_at: expiry })],
      },
    ],
    'write',
  );
  return new Response(null, { status: 303, headers: { location: '/mfa/enroll' } });
};
