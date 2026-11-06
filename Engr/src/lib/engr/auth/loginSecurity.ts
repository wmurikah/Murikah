import type { Client, Transaction } from '@libsql/client/web';
import { requestIp } from './trackedSession.ts';

const FAILURE_THRESHOLD = 5;
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

export function blockSeconds(failures: number): number {
  if (failures < FAILURE_THRESHOLD) return 0;
  return Math.min(MAX_BLOCK_SECONDS, 60 * 2 ** (failures - FAILURE_THRESHOLD));
}

export async function isLoginBlocked(
  db: Client,
  accountHash: string,
  ipHash: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT blocked_until FROM auth_login_limits
           WHERE (scope = 'ACCOUNT' AND key_hash = ?) OR (scope = 'IP' AND key_hash = ?)`,
    args: [accountHash, ipHash],
  });
  const now = Date.now();
  return result.rows.some((row) => Date.parse(String(row.blocked_until ?? '')) > now);
}

async function increment(
  tx: Transaction,
  scope: 'ACCOUNT' | 'IP',
  key: string,
  now: Date,
): Promise<number> {
  const prior = await tx.execute({
    sql: `SELECT failure_count FROM auth_login_limits WHERE scope = ? AND key_hash = ?`,
    args: [scope, key],
  });
  const count = Number(prior.rows[0]?.failure_count ?? 0) + 1;
  const seconds = blockSeconds(count);
  const blocked = seconds ? new Date(now.getTime() + seconds * 1000).toISOString() : null;
  await tx.execute({
    sql: `INSERT INTO auth_login_limits
            (scope, key_hash, failure_count, blocked_until, first_failure_at, last_failure_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope, key_hash) DO UPDATE SET
            failure_count = excluded.failure_count,
            blocked_until = excluded.blocked_until,
            last_failure_at = excluded.last_failure_at`,
    args: [scope, key, count, blocked, now.toISOString(), now.toISOString()],
  });
  return count;
}

export async function recordLoginFailure(
  db: Client,
  keys: { accountHash: string; ipHash: string },
  identity?: { userId: string; orgId: string },
  blocked = false,
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
        blocked ? 'BLOCKED' : 'FAILURE',
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
