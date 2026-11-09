export const prerender = false;
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { readSession } from '@engr/auth/session';
import {
  decryptMfaSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  resolveMfaEncryptionKey,
  verifyTotp,
} from '@engr/auth/mfa';
import { fullSession } from '@engr/auth/loginSession';
import { safeMfaNext } from '@engr/auth/mfaGate';

export const POST: APIRoute = async ({ request }) => {
  const env = getEngrEnv();
  const mfa = resolveMfaEncryptionKey(env.mfaEncryptionKey, '/mfa/challenge?error=config');
  if (!mfa.ok) return mfa.response;
  const secure = new URL(request.url).protocol === 'https:';
  const session = await readSession(request, env.sessionSecret);
  if (!session) return new Response(null, { status: 303, headers: { location: '/login' } });
  const form = await request.formData();
  const code = String(form.get('code') ?? '').trim();
  const next = safeMfaNext(String(form.get('next') ?? '/'), new URL(request.url).origin);
  const db = await getDb(env);
  const result = await db.execute({
    sql: `SELECT m.secret_ciphertext, m.secret_iv, m.last_totp_step,
                 u.session_version, u.full_name, u.email, u.is_platform_owner,
                 o.slug AS org_slug, o.name AS org_name
            FROM user_mfa m
            JOIN users u ON u.id = m.user_id
            JOIN organisations o ON o.id = u.org_id
           WHERE m.user_id = ? AND u.org_id = ? AND m.enabled_at IS NOT NULL LIMIT 1`,
    args: [session.sub, session.org],
  });
  const row = result.rows[0];
  if (!row) return new Response(null, { status: 303, headers: { location: '/mfa/enroll' } });
  const failures = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM audit_logs
           WHERE actor_user_id = ? AND action = 'auth.mfa.challenge.failed'
             AND created_at > ?`,
    args: [session.sub, new Date(Date.now() - 10 * 60_000).toISOString()],
  });
  if (Number(failures.rows[0]?.n ?? 0) >= 5) {
    return new Response(null, {
      status: 303,
      headers: { location: `/mfa/challenge?error=locked&next=${encodeURIComponent(next)}` },
    });
  }
  let method: 'totp' | 'recovery' | null = null;
  const tx = await db.transaction('write');
  try {
    if (/^\d{6}$/.test(code)) {
      const secret = await decryptMfaSecret(
        String(row.secret_ciphertext),
        String(row.secret_iv),
        mfa.key,
      );
      const step = await verifyTotp(secret, code);
      if (step != null && step > Number(row.last_totp_step ?? -1)) {
        const used = await tx.execute({
          sql: `UPDATE user_mfa SET last_totp_step = ?, updated_at = ?
                 WHERE user_id = ? AND (last_totp_step IS NULL OR last_totp_step < ?)`,
          args: [step, new Date().toISOString(), session.sub, step],
        });
        if (used.rowsAffected === 1) method = 'totp';
      }
    } else if (normalizeRecoveryCode(code).length === 10) {
      const hash = await hashRecoveryCode(code);
      const used = await tx.execute({
        sql: `UPDATE mfa_recovery_codes SET used_at = ?
               WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
        args: [new Date().toISOString(), session.sub, hash],
      });
      if (used.rowsAffected === 1) method = 'recovery';
    }
    if (!method) {
      await tx.execute({
        sql: `INSERT INTO audit_logs
                (org_id, actor_user_id, action, entity_type, entity_id, ip, user_agent)
              VALUES (?, ?, 'auth.mfa.challenge.failed', 'user', ?, ?, ?)`,
        args: [
          session.org,
          session.sub,
          session.sub,
          request.headers.get('cf-connecting-ip'),
          request.headers.get('user-agent'),
        ],
      });
      await tx.commit();
      return new Response(null, {
        status: 303,
        headers: { location: `/mfa/challenge?error=code&next=${encodeURIComponent(next)}` },
      });
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs
              (org_id, actor_user_id, action, entity_type, entity_id, after_json, ip, user_agent)
            VALUES (?, ?, 'auth.mfa.challenge', 'user', ?, ?, ?, ?)`,
      args: [
        session.org,
        session.sub,
        session.sub,
        JSON.stringify({ method, step_up: session.authStage !== 'mfa-challenge' }),
        request.headers.get('cf-connecting-ip'),
        request.headers.get('user-agent'),
      ],
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
  const cookie = await fullSession(
    db,
    {
      userId: session.sub,
      orgId: session.org,
      orgSlug: String(row.org_slug),
      orgName: String(row.org_name),
      userName: String(row.full_name),
      userEmail: String(row.email),
      isPlatformOwner: Number(row.is_platform_owner ?? 0) === 1,
      sessionVersion: Number(row.session_version ?? 0),
    },
    env.sessionSecret,
    secure,
    Math.floor(Date.now() / 1000),
    request,
  );
  return new Response(null, { status: 303, headers: { location: next, 'set-cookie': cookie } });
};
