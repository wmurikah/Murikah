import type { Client } from '@libsql/client/web';

const KEY = 'security.mfa_enforced';

/** MFA remains mandatory unless the platform owner explicitly pauses it for
 * this organisation. A missing or malformed setting always fails secure. */
export async function mfaEnforced(db: Client, orgId: string): Promise<boolean> {
  const result = await db.execute({
    sql: `SELECT value_json FROM org_settings WHERE org_id = ? AND key = ? LIMIT 1`,
    args: [orgId, KEY],
  });
  return result.rows[0]?.value_json !== 'false';
}

export async function setMfaEnforced(
  db: Client,
  input: { orgId: string; actorUserId: string; enforced: boolean },
): Promise<void> {
  const tx = await db.transaction('write');
  try {
    const prior = await tx.execute({
      sql: `SELECT value_json FROM org_settings WHERE org_id = ? AND key = ? LIMIT 1`,
      args: [input.orgId, KEY],
    });
    const before = prior.rows[0]?.value_json !== 'false';
    await tx.execute({
      sql: `INSERT INTO org_settings (org_id, key, value_json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(org_id, key) DO UPDATE
              SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      args: [input.orgId, KEY, JSON.stringify(input.enforced), new Date().toISOString()],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs
              (org_id, actor_user_id, action, entity_type, entity_id, before_json, after_json)
            VALUES (?, ?, 'security.mfa.enforcement.update', 'organisation', ?, ?, ?)`,
      args: [
        input.orgId,
        input.actorUserId,
        input.orgId,
        JSON.stringify({ enforced: before }),
        JSON.stringify({ enforced: input.enforced }),
      ],
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
