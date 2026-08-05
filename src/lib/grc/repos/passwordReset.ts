/**
 * The forgotten-password data layer over `password_reset_tokens`. A request
 * issues a single-use token: the raw value goes into the emailed link only,
 * the row stores its SHA-256 hash, an expiry and the requesting IP. Redeeming
 * validates hash, expiry and single-use, then applies the reset in one atomic
 * batch: the new hash written, the forced-change flag cleared, the previous
 * credential recorded in password_history, the token marked used, every
 * session for the user deleted (a compromised session must not survive a
 * reset), and the change audited. No password or token material reaches the
 * audit row.
 *
 * Column names come from the typed schema layer, so a rename fails the build.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { hashToken } from '@grc/auth/session';
import { buildAuditStatement } from '@grc/repos/audit';

const T = cols(C.password_reset_tokens);
const U = cols(C.users);
const PH = cols(C.password_history);
const SESS = cols(C.sessions);

/** How long a reset link stays valid. */
export const RESET_TOKEN_TTL_MINUTES = 45;

/** The durable backstop: at most this many tokens per user per window. */
export const RESET_REQUESTS_PER_HOUR = 3;

/** A fresh raw reset token (256 bits, hex): emailed once, stored only hashed. */
export function newResetToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Recent reset requests for a user, for the durable per-user cap. */
export async function countRecentResetRequests(db: Client, userId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM password_reset_tokens
           WHERE ${T.user_id} = ? AND ${T.created_at} > ?`,
    args: [userId, since],
  });
  return Number(res.rows[0]?.n ?? 0);
}

/** Issue a token row for the user and return the raw token for the link. */
export async function issueResetToken(
  db: Client,
  userId: string,
  requestedIp: string | null,
): Promise<string> {
  const raw = newResetToken();
  const tokenHash = await hashToken(raw);
  const now = Date.now();
  await db.execute({
    sql: `INSERT INTO password_reset_tokens
            (${T.token_id}, ${T.user_id}, ${T.token_hash}, ${T.expires_at}, ${T.used_at},
             ${T.requested_ip}, ${T.created_at})
          VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    args: [
      crypto.randomUUID(),
      userId,
      tokenHash,
      new Date(now + RESET_TOKEN_TTL_MINUTES * 60 * 1000).toISOString(),
      requestedIp,
      new Date(now).toISOString(),
    ],
  });
  return raw;
}

export interface ValidResetToken {
  tokenId: string;
  userId: string;
  organizationId: string;
  /** The stored hash being replaced, recorded in password_history. */
  previousHash: string;
}

/**
 * Resolve a raw token to its user, refusing a hash mismatch, an expired row, a
 * used row, or an inactive user. Returns null in every refusal case so the
 * caller shows one generic invalid-link message.
 */
export async function findValidResetToken(
  db: Client,
  rawToken: string,
): Promise<ValidResetToken | null> {
  const trimmed = rawToken.trim();
  if (trimmed === '') return null;
  const tokenHash = await hashToken(trimmed);
  const res = await db.execute({
    sql: `SELECT t.${T.token_id} AS token_id, t.${T.user_id} AS user_id,
                 u.${U.organization_id} AS organization_id, u.${U.password_hash} AS password_hash
            FROM password_reset_tokens t
            JOIN users u ON u.${U.user_id} = t.${T.user_id}
           WHERE t.${T.token_hash} = ? AND t.${T.used_at} IS NULL AND t.${T.expires_at} > ?
             AND u.${U.deleted_at} IS NULL AND u.${U.status} = 'ACTIVE'
           LIMIT 1`,
    args: [tokenHash, new Date().toISOString()],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    tokenId: String(row.token_id),
    userId: String(row.user_id),
    organizationId: String(row.organization_id),
    previousHash: row.password_hash == null ? '' : String(row.password_hash),
  };
}

/** Split a stored pbkdf2$iterations$salt$hash value for the history columns. */
function splitStored(stored: string): { algo: string; salt: string; hash: string } {
  const parts = stored.trim().split('$');
  if (parts.length === 4 && parts[0] === 'pbkdf2') {
    return { algo: `${parts[0]}$${parts[1]}`, salt: parts[2], hash: parts[3] };
  }
  return { algo: 'unknown', salt: '', hash: stored };
}

/**
 * Redeem a validated token: one atomic batch marking it used, writing the new
 * hash, clearing the forced-change flag, recording history, deleting every
 * session for the user and auditing the reset.
 */
export async function applyPasswordReset(
  db: Client,
  token: ValidResetToken,
  newHash: string,
): Promise<void> {
  const now = new Date().toISOString();
  const prev = splitStored(token.previousHash);
  await db.batch(
    [
      {
        sql: `UPDATE password_reset_tokens SET ${T.used_at} = ?
               WHERE ${T.token_id} = ? AND ${T.used_at} IS NULL`,
        args: [now, token.tokenId],
      },
      {
        sql: `UPDATE users
                 SET ${U.password_hash} = ?, ${U.must_change_password} = 0, ${U.updated_at} = ?
               WHERE ${U.user_id} = ? AND ${U.organization_id} = ?`,
        args: [newHash, now, token.userId, token.organizationId],
      },
      {
        sql: `INSERT INTO password_history
                (${PH.history_id}, ${PH.user_id}, ${PH.password_hash}, ${PH.password_salt},
                 ${PH.password_algo}, ${PH.changed_at}, ${PH.changed_by})
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          crypto.randomUUID(),
          token.userId,
          prev.hash,
          prev.salt,
          prev.algo,
          now,
          token.userId,
        ],
      },
      {
        // Every session dies with the old credential, on every device.
        sql: `DELETE FROM sessions WHERE ${SESS.user_id} = ?`,
        args: [token.userId],
      },
      buildAuditStatement({
        organizationId: token.organizationId,
        userId: token.userId,
        action: 'USER.password_reset',
        entityType: 'user',
        entityId: token.userId,
        details: 'Password reset through the emailed link; all sessions invalidated.',
      }),
    ],
    'write',
  );
}
