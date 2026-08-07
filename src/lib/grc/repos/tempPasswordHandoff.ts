/**
 * The shown-once handoff of a generated temporary password to the admin who
 * caused it (Build Prompt 39).
 *
 * The admin needs to see the password once, so they can pass it on when the
 * email does not arrive. It must not travel in a redirect query string: that
 * would put a live credential in the browser history, the referrer header and
 * any access log. So it takes the same route the sealed backup codes already
 * take: sealed with GRC_SESSION_SECRET (auth/secretBox.ts) into a `config` row,
 * read back by the page that shows it, and deleted in the same breath. Reading
 * it twice returns nothing, which is what makes "shown once" true rather than a
 * promise in the copy.
 *
 * The row is scoped to the acting organisation and bound to the acting admin, so
 * one administrator can never pick up a password minted by another, and it
 * carries its own age so a row orphaned by a failed render expires rather than
 * lingering as a readable credential.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { seal, open } from '@grc/auth/secretBox';

const cfg = cols(C.config);

/** How long an unread handoff stays readable. Beyond this it is discarded. */
export const HANDOFF_TTL_MS = 15 * 60 * 1000;

const key = (userId: string): string => `USER_TEMP_PW::${userId}`;

interface StoredHandoff {
  sealed: string;
  /** The admin who minted it; only they may read it back. */
  actorUserId: string;
  createdAt: string;
}

export interface TemporaryPasswordHandoff {
  /** The plaintext, for this one render only. */
  password: string;
}

/** Seal a freshly generated password for the admin who minted it. */
export async function stashTemporaryPassword(
  db: Client,
  secret: string,
  organizationId: string,
  userId: string,
  actorUserId: string,
  password: string,
): Promise<void> {
  const record: StoredHandoff = {
    sealed: await seal(secret, password),
    actorUserId,
    createdAt: new Date().toISOString(),
  };
  const value = JSON.stringify(record);
  const now = new Date().toISOString();
  const upd = await db.execute({
    sql: `UPDATE config SET ${cfg.config_value} = ?, ${cfg.updated_at} = ?
           WHERE ${cfg.organization_id} = ? AND ${cfg.config_key} = ?`,
    args: [value, now, organizationId, key(userId)],
  });
  if ((upd.rowsAffected ?? 0) === 0) {
    await db.execute({
      sql: `INSERT INTO config (${cfg.organization_id}, ${cfg.config_key}, ${cfg.config_value}, ${cfg.updated_at})
             VALUES (?, ?, ?, ?)`,
      args: [organizationId, key(userId), value, now],
    });
  }
}

async function discard(db: Client, organizationId: string, userId: string): Promise<void> {
  await db.execute({
    sql: `DELETE FROM config WHERE ${cfg.organization_id} = ? AND ${cfg.config_key} = ?`,
    args: [organizationId, key(userId)],
  });
}

/**
 * Read a stashed password and delete it, so it can only ever be shown once.
 * Returns null when there is nothing to show, when the row belongs to another
 * admin, when it has aged out, or when it cannot be unsealed. The row is deleted
 * in every one of those cases too: an unreadable or expired credential has no
 * reason to survive the attempt.
 */
export async function takeTemporaryPassword(
  db: Client,
  secret: string,
  organizationId: string,
  userId: string,
  actorUserId: string,
): Promise<TemporaryPasswordHandoff | null> {
  const res = await db.execute({
    sql: `SELECT ${cfg.config_value} AS v FROM config
           WHERE ${cfg.organization_id} = ? AND ${cfg.config_key} = ? LIMIT 1`,
    args: [organizationId, key(userId)],
  });
  const raw = res.rows[0]?.v;
  if (raw == null) return null;

  let record: StoredHandoff | null = null;
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (parsed && typeof parsed === 'object') {
      const v = parsed as Record<string, unknown>;
      if (typeof v.sealed === 'string' && typeof v.actorUserId === 'string') {
        record = {
          sealed: v.sealed,
          actorUserId: v.actorUserId,
          createdAt: typeof v.createdAt === 'string' ? v.createdAt : '',
        };
      }
    }
  } catch {
    // A malformed row is treated as nothing to show, and cleared below.
  }

  // Another administrator's handoff is left exactly where it is: it is not
  // this admin's to read, and certainly not theirs to delete.
  if (record && record.actorUserId !== actorUserId) return null;

  await discard(db, organizationId, userId);
  if (!record) return null;

  const age = Date.parse(record.createdAt);
  if (!Number.isNaN(age) && Date.now() - age > HANDOFF_TTL_MS) return null;

  const password = await open(secret, record.sealed);
  return password ? { password } : null;
}
