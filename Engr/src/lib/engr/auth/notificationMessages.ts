/** Authentication mail is an encrypted queue payload, not a reusable bearer
 * link in a general-purpose notification row. The separate Worker secret must
 * be a Base64-encoded 32-byte key. The token hash and expiry are non-secret
 * metadata; AES-GCM binds them to this notification, tenant, recipient and
 * template so copying ciphertext between rows cannot change its meaning. */
import type { Client, Transaction } from '@libsql/client/web';
import type { IssuedAuthToken } from './tokens';
import { hashOpaqueToken } from './tokens.ts';

const PREFIX = 'authenc:v1:';
const REDACTED = '[authentication link removed]';
const INVALID = 'Authentication link is no longer valid; request a new one.';
const HEADER = /^authenc:v1:(\d{13}):([a-f0-9]{64}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]+)$/;

export type AuthMessageTemplate = 'auth.invitation' | 'auth.password.reset';

export interface AuthMessageContext {
  id: string;
  orgId: string;
  userId: string;
  templateKey: AuthMessageTemplate;
}

export function authMessageTemplate(value: unknown): AuthMessageTemplate | null {
  return value === 'auth.invitation' || value === 'auth.password.reset' ? value : null;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function keyBytes(configured: string | null | undefined): Uint8Array<ArrayBuffer> | null {
  if (!configured || !/^[A-Za-z0-9+/]{43}=$/.test(configured)) return null;
  try {
    const bytes = fromBase64(configured);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function authMessageKeyReady(configured: string | null | undefined): boolean {
  return keyBytes(configured) !== null;
}

function additionalData(
  context: AuthMessageContext,
  expiresAtMs: number,
  hash: string,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([
      context.id,
      context.orgId,
      context.userId,
      context.templateKey,
      expiresAtMs,
      hash,
    ]),
  );
}

export async function encryptAuthMessage(
  body: string,
  context: AuthMessageContext,
  issued: IssuedAuthToken,
  keySecret: string,
): Promise<string> {
  const rawKey = keyBytes(keySecret);
  if (!rawKey) throw new Error('ENGR_AUTH_MESSAGE_KEY must contain 32 Base64-encoded bytes.');
  const expiresAtMs = Date.parse(issued.expiresAt);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 1_000_000_000_000) {
    throw new Error('Authentication token expiry is invalid.');
  }
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additionalData(context, expiresAtMs, issued.hash) },
    key,
    new TextEncoder().encode(body),
  );
  return `${PREFIX}${expiresAtMs}:${issued.hash}:${base64Url(iv)}:${base64Url(new Uint8Array(ciphertext))}`;
}

function parseEnvelope(body: string | null): {
  expiresAtMs: number;
  hash: string;
  iv: Uint8Array<ArrayBuffer>;
  ciphertext: Uint8Array<ArrayBuffer>;
} | null {
  const match = body && HEADER.exec(body);
  if (!match) return null;
  try {
    const iv = fromBase64(match[3]);
    const ciphertext = fromBase64(match[4]);
    if (iv.length !== 12 || ciphertext.length < 17) return null;
    return { expiresAtMs: Number(match[1]), hash: match[2], iv, ciphertext };
  } catch {
    return null;
  }
}

export async function authMessageForDelivery(
  db: Client,
  storedBody: string | null,
  context: AuthMessageContext,
  keySecret: string,
  now: Date,
): Promise<string | null> {
  const envelope = parseEnvelope(storedBody);
  const rawKey = keyBytes(keySecret);
  if (!envelope || !rawKey || envelope.expiresAtMs <= now.getTime()) return null;
  const purpose = context.templateKey === 'auth.invitation' ? 'INVITE' : 'RESET';
  const token = await db.execute({
    sql: `SELECT 1 FROM auth_tokens
           WHERE org_id = ? AND user_id = ? AND purpose = ? AND token_hash = ?
             AND used_at IS NULL AND expires_at > ? LIMIT 1`,
    args: [context.orgId, context.userId, purpose, envelope.hash, now.toISOString()],
  });
  if (!token.rows.length) return null;
  try {
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    const clear = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: envelope.iv,
        additionalData: additionalData(context, envelope.expiresAtMs, envelope.hash),
      },
      key,
      envelope.ciphertext,
    );
    return new TextDecoder().decode(clear);
  } catch {
    // Bad key or tampered envelope: never send unverified authentication mail.
    return null;
  }
}

/** Revoke every still-usable legacy plaintext link before removing it from the
 * queue. This runs even when email delivery or the new encryption key is absent. */
export async function scrubLegacyAuthMessages(db: Client, now: Date): Promise<number> {
  const tx = await db.transaction('write');
  try {
    const legacy = await tx.execute({
      sql: `SELECT id, org_id, recipient_user_id, template_key, body FROM notifications
             WHERE channel = 'EMAIL' AND template_key IN ('auth.invitation','auth.password.reset')
               AND body LIKE '%/set-password?token=%'`,
      args: [],
    });
    let redacted = 0;
    for (const row of legacy.rows) {
      const body = String(row.body);
      const token = /\/set-password\?token=([A-Za-z0-9_-]+)/.exec(body)?.[1];
      if (token && row.recipient_user_id != null) {
        await tx.execute({
          sql: `UPDATE auth_tokens SET used_at = ?
                 WHERE org_id = ? AND user_id = ? AND purpose = ?
                   AND token_hash = ? AND used_at IS NULL`,
          args: [
            now.toISOString(),
            String(row.org_id),
            String(row.recipient_user_id),
            row.template_key === 'auth.invitation' ? 'INVITE' : 'RESET',
            await hashOpaqueToken(token),
          ],
        });
      }
      const scrubbed = await tx.execute({
        sql: `UPDATE notifications
                 SET body = ?,
                     status = CASE WHEN status IN ('QUEUED','FAILED') THEN 'FAILED' ELSE status END,
                     error = CASE WHEN status IN ('QUEUED','FAILED') THEN ? ELSE error END
               WHERE id = ? AND body = ?`,
        args: [
          REDACTED,
          'Legacy authentication link revoked; request a new one.',
          String(row.id),
          body,
        ],
      });
      redacted += scrubbed.rowsAffected;
    }
    await tx.commit();
    return redacted;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

/** Remove encrypted payloads after expiry, redemption or supersession. The
 * token hash is readable metadata, so this works without decrypting a link. */
export async function scrubInactiveAuthMessages(db: Client, now: Date): Promise<number> {
  const redacted = await db.execute({
    sql: `UPDATE notifications AS n
             SET body = ?,
                 status = CASE WHEN status IN ('QUEUED','FAILED') THEN 'FAILED' ELSE status END,
                 error = CASE WHEN status IN ('QUEUED','FAILED') THEN ? ELSE error END
           WHERE n.channel = 'EMAIL' AND n.template_key IN ('auth.invitation','auth.password.reset')
             AND n.body LIKE 'authenc:v1:%'
             AND NOT EXISTS (
               SELECT 1 FROM auth_tokens t
                WHERE t.org_id = n.org_id AND t.user_id = n.recipient_user_id
                  AND t.purpose = CASE n.template_key
                    WHEN 'auth.invitation' THEN 'INVITE' ELSE 'RESET' END
                  AND t.token_hash = substr(n.body, ?, 64)
                  AND t.used_at IS NULL AND t.expires_at > ?
             )`,
    args: [REDACTED, INVALID, PREFIX.length + 15, now.toISOString()],
  });
  return redacted.rowsAffected;
}

export async function redactAuthMessage(db: Client, id: string, reason?: string): Promise<void> {
  await db.execute({
    sql: `UPDATE notifications SET body = ?, error = COALESCE(?, error) WHERE id = ?`,
    args: [REDACTED, reason ?? null, id],
  });
}

/** A completed password setup or administrator reset invalidates every pending
 * link for that account, including legacy plaintext notifications. */
export async function redactUserAuthMessages(
  db: Client | Transaction,
  orgId: string,
  userId: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE notifications
             SET body = ?,
                 status = CASE WHEN status IN ('QUEUED','FAILED') THEN 'FAILED' ELSE status END,
                 error = CASE WHEN status IN ('QUEUED','FAILED') THEN ? ELSE error END
           WHERE org_id = ? AND recipient_user_id = ? AND channel = 'EMAIL'
             AND template_key IN ('auth.invitation','auth.password.reset')
             AND (body LIKE 'authenc:v1:%' OR body LIKE '%/set-password?token=%')`,
    args: [REDACTED, INVALID, orgId, userId],
  });
}
