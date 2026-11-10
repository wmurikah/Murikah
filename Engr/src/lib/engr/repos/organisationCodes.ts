/**
 * Tenant-local, human-readable codes. Generated only inside the transaction
 * that creates the row. Existing hand-entered codes remain unchanged.
 *
 * Concurrent creators may choose the same next number; a UNIQUE violation
 * causes the caller to retry in a new transaction. No user input is accepted.
 */
import type { SqlExecutor } from '../notify';

export async function nextOrganisationCode(
  db: SqlExecutor,
  orgId: string,
  kind: 'region' | 'station',
): Promise<string> {
  const table = kind === 'region' ? 'regions' : 'stations';
  const prefix = kind === 'region' ? 'REG' : 'STN';
  const result = await db.execute({
    sql: `SELECT COALESCE(MAX(CAST(SUBSTR(code, 5) AS INTEGER)), 0) AS last_number
            FROM ${table}
           WHERE org_id = ? AND code GLOB ?`,
    args: [orgId, `${prefix}-[0-9][0-9][0-9][0-9][0-9][0-9]`],
  });
  const next = Number(result.rows[0]?.last_number ?? 0) + 1;
  if (!Number.isSafeInteger(next) || next > 999999) {
    throw new Error(`Exhausted ${kind} codes for this affiliate.`);
  }
  return `${prefix}-${String(next).padStart(6, '0')}`;
}
