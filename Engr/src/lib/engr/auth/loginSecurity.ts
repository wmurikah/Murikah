import type { Client, Transaction } from '@libsql/client/web';
import { requestIp } from './trackedSession.ts';

const FAILURE_THRESHOLD = 5;
// A shared office address can have many legitimate users. Keep account
// throttling strict while requiring more failures to block the whole address.
const IP_FAILURE_THRESHOLD = 30;
const MAX_BLOCK_SECONDS = 30 * 60;

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function loginKeys(email: string, request: Request) {
  return {
    accountHash: await accountLoginHash(email),
    ipHash: await hash(requestIp(request)),
  };
}

export async function accountLoginHash(email: string): Promise<string> {
  return hash(email.trim().toLowerCase());
}

export function blockSeconds(failures: number, scope: 'ACCOUNT' | 'IP' = 'ACCOUNT'): number {
  const threshold = scope === 'IP' ? IP_FAILURE_THRESHOLD : FAILURE_THRESHOLD;
  if (failures < threshold) return 0;
  return Math.min(MAX_BLOCK_SECONDS, 60 * 2 ** (failures - threshold));
}

export async function isLoginBlocked(
  db: Client,
  accountHash: string,
  ipHash: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - MAX_BLOCK_SECONDS * 1000).toISOString();
  const result = await db.execute({
    sql: `SELECT l.scope, l.blocked_until,
                 CASE WHEN l.scope = 'ACCOUNT' THEN
                   (SELECT COUNT(*) FROM auth_login_events e
                     WHERE e.account_hash = ? AND e.outcome = 'FAILURE'
                       AND e.created_at >= MAX(COALESCE(l.first_failure_at, ''), ?))
                 ELSE
                   (SELECT COUNT(*) FROM auth_login_events e
                     WHERE e.ip_hash = ? AND e.outcome = 'FAILURE'
                       AND e.created_at >= MAX(COALESCE(l.first_failure_at, ''), ?))
                 END AS recent_failures
            FROM auth_login_limits l
           WHERE (l.scope = 'ACCOUNT' AND l.key_hash = ?)
              OR (l.scope = 'IP' AND l.key_hash = ?)`,
    args: [accountHash, cutoff, ipHash, cutoff, accountHash, ipHash],
  });
  const now = Date.now();
  return result.rows.some((row) => {
    const scope = String(row.scope) as 'ACCOUNT' | 'IP';
    return (
      Number(row.recent_failures ?? 0) >=
        (scope === 'IP' ? IP_FAILURE_THRESHOLD : FAILURE_THRESHOLD) &&
      Date.parse(String(row.blocked_until ?? '')) > now
    );
  });
}

async function increment(
  tx: Transaction,
  scope: 'ACCOUNT' | 'IP',
  key: string,
  now: Date,
): Promise<number> {
  const prior = await tx.execute({
    sql: `SELECT first_failure_at FROM auth_login_limits WHERE scope = ? AND key_hash = ?`,
    args: [scope, key],
  });
  const cutoff = new Date(now.getTime() - MAX_BLOCK_SECONDS * 1000).toISOString();
  const from = prior.rows[0]
    ? String(prior.rows[0].first_failure_at ?? '') > cutoff
      ? String(prior.rows[0].first_failure_at)
      : cutoff
    : now.toISOString();
  const column = scope === 'ACCOUNT' ? 'account_hash' : 'ip_hash';
  const recent = prior.rows[0]
    ? await tx.execute({
        sql: `SELECT COUNT(*) AS n, MIN(created_at) AS first_at FROM auth_login_events
               WHERE ${column} = ? AND outcome = 'FAILURE' AND created_at >= ?`,
        args: [key, from],
      })
    : null;
  const count = Number(recent?.rows[0]?.n ?? 0) + 1;
  const seconds = blockSeconds(count, scope);
  const blocked = seconds ? new Date(now.getTime() + seconds * 1000).toISOString() : null;
  const firstFailure = String(recent?.rows[0]?.first_at ?? now.toISOString());
  await tx.execute({
    sql: `INSERT INTO auth_login_limits
            (scope, key_hash, failure_count, blocked_until, first_failure_at, last_failure_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope, key_hash) DO UPDATE SET
            failure_count = excluded.failure_count,
            blocked_until = excluded.blocked_until,
            first_failure_at = excluded.first_failure_at,
            last_failure_at = excluded.last_failure_at`,
    args: [scope, key, count, blocked, firstFailure, now.toISOString()],
  });
  return count;
}

export async function recordLoginFailure(
  db: Client,
  keys: { accountHash: string; ipHash: string },
  identity?: { userId: string; orgId: string },
): Promise<void> {
  const tx = await db.transaction('write');
  try {
    const now = new Date();
    const accountCount = await increment(tx, 'ACCOUNT', keys.accountHash, now);
    await increment(tx, 'IP', keys.ipHash, now);
    await tx.execute({
      sql: `INSERT INTO auth_login_events
              (account_hash, ip_hash, org_id, user_id, outcome, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        keys.accountHash,
        keys.ipHash,
        identity?.orgId ?? null,
        identity?.userId ?? null,
        'FAILURE',
        now.toISOString(),
      ],
    });
    if (identity && [5, 10, 20].includes(accountCount)) {
      await tx.execute({
        sql: `INSERT INTO notifications
                (org_id, channel, recipient_user_id, template_key, subject, body,
                 entity_type, entity_id, status)
              SELECT ?, 'IN_APP', ur.user_id, 'security.login.attack',
                     'Repeated failed sign-in attempts',
                     'Repeated failed sign-in attempts were detected for an account in your organisation.',
                     'user', ?, 'QUEUED'
                FROM user_roles ur JOIN roles r ON r.id = ur.role_id
               WHERE r.code IN ('OWNER','ADMIN')
                 AND (r.org_id IS NULL OR r.org_id = ?)
                 AND ur.user_id IN (SELECT id FROM users WHERE org_id = ? AND status = 'ACTIVE')`,
        args: [identity.orgId, identity.userId, identity.orgId, identity.orgId],
      });
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}

/** Log a denied retry without extending either lockout. Repeated clicks on
 * Sign in must not keep a legitimate user locked out indefinitely. */
export async function recordLoginBlocked(
  db: Client,
  keys: { accountHash: string; ipHash: string },
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO auth_login_events (account_hash, ip_hash, outcome)
          VALUES (?, ?, 'BLOCKED')`,
    args: [keys.accountHash, keys.ipHash],
  });
}

export async function recordLoginSuccess(
  db: Client,
  keys: { accountHash: string; ipHash: string },
  identity: { userId: string; orgId: string },
): Promise<void> {
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `DELETE FROM auth_login_limits
             WHERE (scope = 'ACCOUNT' AND key_hash = ?) OR (scope = 'IP' AND key_hash = ?)`,
      args: [keys.accountHash, keys.ipHash],
    });
    await tx.execute({
      sql: `INSERT INTO auth_login_events
              (account_hash, ip_hash, org_id, user_id, outcome)
            VALUES (?, ?, ?, ?, 'SUCCESS')`,
      args: [keys.accountHash, keys.ipHash, identity.orgId, identity.userId],
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
