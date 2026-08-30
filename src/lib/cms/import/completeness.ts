/**
 * The prerequisite check every importer runs before it touches a row.
 *
 * The operator's source-completeness script is what makes "unknown" storable:
 * it relaxes the commercial columns on the order tables to accept NULL and
 * adds `purchase_orders.submitted_for_approval_at`. Where it has not been
 * run, an import would either fail on a NOT NULL constraint or, far worse,
 * write an invented zero to get past one. So the importers ask the database
 * itself, with pragma queries, and refuse to start when the answer is no.
 *
 * ONE CHECKER, TWO IMPORTERS. The sales order and purchase order importers
 * name different columns; the mechanism is this file and nothing else.
 */
import type { Client } from '@libsql/client/web';

export interface ColumnRequirement {
  table: string;
  column: string;
  /** EXISTS means the column merely has to be there; NULLABLE also demands it accept NULL. */
  requirement: 'EXISTS' | 'NULLABLE';
}

export interface CompletenessResult {
  ok: boolean;
  problems: string[];
  checked: { table: string; column: string; exists: boolean; nullable: boolean }[];
}

export async function verifyColumns(
  db: Client,
  requirements: readonly ColumnRequirement[],
): Promise<CompletenessResult> {
  const problems: string[] = [];
  const checked: CompletenessResult['checked'] = [];
  for (const requirement of requirements) {
    const result = await db.execute({
      sql: `SELECT "notnull" AS nn FROM pragma_table_info(?) WHERE name = ?`,
      args: [requirement.table, requirement.column],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    const exists = row !== undefined;
    const nullable = exists && Number(row?.nn) !== 1;
    checked.push({ table: requirement.table, column: requirement.column, exists, nullable });
    if (!exists) {
      problems.push(`${requirement.table}.${requirement.column} does not exist`);
    } else if (requirement.requirement === 'NULLABLE' && !nullable) {
      problems.push(
        `${requirement.table}.${requirement.column} is NOT NULL, so unknown values cannot be stored honestly`,
      );
    }
  }
  return { ok: problems.length === 0, problems, checked };
}
