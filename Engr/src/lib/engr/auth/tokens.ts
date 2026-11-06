import type { Client, Transaction } from '@libsql/client/web';

export type AuthTokenPurpose = 'INVITE' | 'RESET';
type Db = Client | Transaction;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function hashOpaqueToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function newOpaqueToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function issueAuthToken(
  db: Db,
  input: {
    orgId: string;
    userId: string;
    purpose: AuthTokenPurpose;
    createdBy: string | null;
    lifetimeMinutes: number;
  },
): Promise<string> {
  const token = newOpaqueToken();
  const tokenHash = await hashOpaqueToken(token);
  const expiresAt = new Date(Date.now() + input.lifetimeMinutes * 60_000).toISOString();
  await db.execute({
    sql: `UPDATE auth_tokens SET used_at = ?
           WHERE user_id = ? AND purpose = ? AND used_at IS NULL`,
    args: [new Date().toISOString(), input.userId, input.purpose],
  });
  await db.execute({
    sql: `INSERT INTO auth_tokens
            (org_id, user_id, purpose, token_hash, expires_at, created_by)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [input.orgId, input.userId, input.purpose, tokenHash, expiresAt, input.createdBy],
  });
  return token;
}

export function authLink(origin: string, token: string): string {
  const url = new URL('/set-password', origin);
  url.searchParams.set('token', token);
  return url.toString();
}
