export const prerender = false;
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { authLink, issueAuthTokenWithMetadata } from '@engr/auth/tokens';
import { authMessageKeyReady, encryptAuthMessage } from '@engr/auth/notificationMessages';

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const email = String(form.get('email') ?? '')
    .trim()
    .toLowerCase();
  const env = getEngrEnv();
  const db = await getDb(env);
  const result = await db.execute({
    sql: `SELECT u.id, u.org_id FROM users u
           WHERE u.email = ? AND u.status = 'ACTIVE' AND u.password_hash IS NOT NULL
             AND u.deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM auth_tokens t
                WHERE t.user_id = u.id AND t.purpose = 'RESET'
                  AND t.created_at > ?
             )
           LIMIT 1`,
    args: [email, new Date(Date.now() - 5 * 60_000).toISOString()],
  });
  const user = result.rows[0];
  if (user && !authMessageKeyReady(env.authMessageKey)) {
    console.error('[engr.auth.forgot] authentication email encryption is not configured');
  }
  if (user && authMessageKeyReady(env.authMessageKey)) {
    const tx = await db.transaction('write');
    try {
      const issued = await issueAuthTokenWithMetadata(tx, {
        orgId: String(user.org_id),
        userId: String(user.id),
        purpose: 'RESET',
        createdBy: null,
        lifetimeMinutes: 60,
      });
      const link = authLink(new URL(request.url).origin, issued.value);
      const notificationId = crypto.randomUUID().replaceAll('-', '');
      const body = await encryptAuthMessage(
        `A password reset was requested. This link expires in one hour and works once: ${link}`,
        {
          id: notificationId,
          orgId: String(user.org_id),
          userId: String(user.id),
          templateKey: 'auth.password.reset',
        },
        issued,
        env.authMessageKey!,
      );
      await tx.execute({
        sql: `INSERT INTO notifications
                (id, org_id, channel, recipient_user_id, to_address, template_key, subject, body,
                 entity_type, entity_id, status)
              VALUES (?, ?, 'EMAIL', ?, ?, 'auth.password.reset', 'Reset your Engineering Rhythm password', ?,
                      'user', ?, 'QUEUED')`,
        args: [notificationId, String(user.org_id), String(user.id), email, body, String(user.id)],
      });
      await tx.execute({
        sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, NULL, 'auth.password.reset.request', 'user', ?, ?)`,
        args: [String(user.org_id), String(user.id), JSON.stringify({ delivery: 'EMAIL' })],
      });
      await tx.commit();
    } catch {
      await tx.rollback();
      // Keep the public response indistinguishable for existing and unknown
      // addresses. Operators can diagnose delivery through notification/audit
      // health without exposing account existence here.
    }
  }
  // Always identical: never reveal whether the address exists.
  return new Response(null, { status: 303, headers: { location: '/forgot?sent=1' } });
};
