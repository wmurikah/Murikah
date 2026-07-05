/**
 * The change-password data layer. Reads the acting user's current credential to
 * verify against, then applies the change atomically: the new hash is written,
 * the forced-change flag cleared, the previous credential recorded in
 * password_history (so a future policy can prevent reuse), and the change
 * audited. No password material reaches the audit row.
 *
 * Every read and write is scoped by the acting organization_id, and every column
 * name comes from the typed schema layer (@grc/schema/columns), so a rename fails
 * the build rather than a login.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { buildAuditStatement } from '@grc/repos/audit';

const U = cols(C.users);
const PH = cols(C.password_history);

export interface PasswordState {
  passwordHash: string;
  mustChangePassword: boolean;
}

/** The user's current password hash and forced-change flag, scoped to the org. */
export async function getPasswordState(
  db: Client,
  userId: string,
  organizationId: string,
): Promise<PasswordState | null> {
  const res = await db.execute({
    sql: `SELECT ${U.password_hash} AS password_hash, ${U.must_change_password} AS must_change
            FROM users
           WHERE ${U.user_id} = ? AND ${U.organization_id} = ? AND ${U.deleted_at} IS NULL
           LIMIT 1`,
    args: [userId, organizationId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    passwordHash: row.password_hash == null ? '' : String(row.password_hash),
    mustChangePassword: Number(row.must_change ?? 0) === 1,
  };
}

/**
 * Split a stored pbkdf2$iterations$salt$hash value into the parts the history
 * columns hold: the algorithm and iteration count, the base64 salt and the
 * base64 hash. An unrecognised format is preserved whole in the hash column so
 * nothing is lost.
 */
function splitStored(stored: string): { algo: string; salt: string; hash: string } {
  const parts = stored.trim().split('$');
  if (parts.length === 4 && parts[0] === 'pbkdf2') {
    return { algo: `${parts[0]}$${parts[1]}`, salt: parts[2], hash: parts[3] };
  }
  return { algo: 'unknown', salt: '', hash: stored };
}

export interface ApplyPasswordChange {
  userId: string;
  organizationId: string;
  /** The current stored hash, recorded in history before it is replaced. */
  previousHash: string;
  /** The new hash, already in the canonical pbkdf2 scheme. */
  newHash: string;
}

/**
 * Apply a password change in one atomic batch: update the user's hash and clear
 * the forced-change flag, record the previous credential in password_history,
 * and write the audit row. Scoped by organization_id on the update.
 */
export async function applyPasswordChange(db: Client, params: ApplyPasswordChange): Promise<void> {
  const now = new Date().toISOString();
  const prev = splitStored(params.previousHash);
  await db.batch(
    [
      {
        sql: `UPDATE users
                 SET ${U.password_hash} = ?, ${U.must_change_password} = 0, ${U.updated_at} = ?
               WHERE ${U.user_id} = ? AND ${U.organization_id} = ?`,
        args: [params.newHash, now, params.userId, params.organizationId],
      },
      {
        sql: `INSERT INTO password_history
                (${PH.history_id}, ${PH.user_id}, ${PH.password_hash}, ${PH.password_salt},
                 ${PH.password_algo}, ${PH.changed_at}, ${PH.changed_by})
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          crypto.randomUUID(),
          params.userId,
          prev.hash,
          prev.salt,
          prev.algo,
          now,
          params.userId,
        ],
      },
      buildAuditStatement({
        organizationId: params.organizationId,
        userId: params.userId,
        action: 'USER.password_change',
        entityType: 'user',
        entityId: params.userId,
        details: 'Password changed by the account holder.',
      }),
    ],
    'write',
  );
}
