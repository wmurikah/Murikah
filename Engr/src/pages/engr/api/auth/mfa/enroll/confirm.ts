export const prerender = false;
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { readSession } from '@engr/auth/session';
import {
  decryptMfaSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyTotp,
} from '@engr/auth/mfa';
import { fullSession } from '@engr/auth/loginSession';

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char] ?? char,
  );
}

export const POST: APIRoute = async ({ request }) => {
  const env = getEngrEnv();
  const secure = new URL(request.url).protocol === 'https:';
  const session = await readSession(request, env.sessionSecret);
  if (!session) return new Response(null, { status: 303, headers: { location: '/login' } });
  const form = await request.formData();
  const code = String(form.get('code') ?? '').trim();
  const db = await getDb(env);
  const result = await db.execute({
    sql: `SELECT m.secret_ciphertext, m.secret_iv, m.pending_expires_at, m.enabled_at,
                 u.session_version, u.full_name, u.email, u.is_platform_owner,
                 o.slug AS org_slug, o.name AS org_name
            FROM user_mfa m
            JOIN users u ON u.id = m.user_id
            JOIN organisations o ON o.id = u.org_id
           WHERE m.user_id = ? AND u.org_id = ? LIMIT 1`,
    args: [session.sub, session.org],
  });
  const row = result.rows[0];
  if (
    !row ||
    row.enabled_at != null ||
    String(row.pending_expires_at ?? '') <= new Date().toISOString()
  ) {
    return new Response(null, { status: 303, headers: { location: '/mfa/enroll?error=code' } });
  }
  const secret = await decryptMfaSecret(
    String(row.secret_ciphertext),
    String(row.secret_iv),
    env.mfaEncryptionKey,
  );
  const step = await verifyTotp(secret, code);
  if (step == null) {
    return new Response(null, { status: 303, headers: { location: '/mfa/enroll?error=code' } });
  }
  const codes = generateRecoveryCodes();
  const hashes = await Promise.all(codes.map(hashRecoveryCode));
  const version = Number(row.session_version ?? 0);
  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `UPDATE user_mfa
               SET enabled_at = ?, pending_expires_at = NULL, last_totp_step = ?,
                   updated_at = ?
             WHERE user_id = ? AND enabled_at IS NULL`,
      args: [now, step, now, session.sub],
    });
    await tx.execute({
      sql: `DELETE FROM mfa_recovery_codes WHERE user_id = ?`,
      args: [session.sub],
    });
    for (const hash of hashes) {
      await tx.execute({
        sql: `INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?, ?)`,
        args: [session.sub, hash],
      });
    }
    await tx.execute({
      sql: `UPDATE users SET session_version = session_version + 1 WHERE id = ? AND org_id = ?`,
      args: [session.sub, session.org],
    });
    await tx.execute({
      sql: `UPDATE auth_sessions SET revoked_at = ?, revoked_reason = 'MFA enabled'
             WHERE user_id = ? AND revoked_at IS NULL`,
      args: [now, session.sub],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs
              (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'auth.mfa.enabled', 'user', ?, ?)`,
      args: [
        session.org,
        session.sub,
        session.sub,
        JSON.stringify({ recovery_codes: hashes.length }),
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
      sessionVersion: version + 1,
    },
    env.sessionSecret,
    secure,
    Math.floor(Date.now() / 1000),
    request,
  );
  const list = codes.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join('');
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>Recovery codes</title></head><body><main><h1>Save your recovery codes</h1><p>Each code works once. Store them somewhere safe; they will not be shown again.</p><ol>${list}</ol><p><a href="/">I have saved these codes</a></p></main></body></html>`,
    {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': cookie,
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      },
    },
  );
};
