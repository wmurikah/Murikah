/**
 * Turning "FOREIGN KEY constraint failed" into a sentence that names the
 * table, the column and the value.
 *
 * WHY THIS EXISTS. Three purchase order batches failed with exactly this,
 * and nothing else:
 *
 *   The purchase order could not be written: LibsqlBatchError:
 *   SQLITE_CONSTRAINT: FOREIGN KEY constraint failed
 *
 * That message is true and useless. It does not say which of the four
 * foreign keys on the two purchase order tables rejected the write, which
 * column carried the bad value, or what the value was. Finding out cost two
 * days, and the answer turned out to be one line of string handling writing
 * a document number into `affiliate_id`. Had the message named
 * `purchase_orders.affiliate_id = '9296'`, it would have cost a minute.
 *
 * SQLite does not tell us which key failed; it does not carry that in the
 * error. So this asks the database instead: given the statements that were in
 * the failed transaction, take every foreign key those tables declare, look
 * up each value that was about to be written, and report the ones that are
 * not there. The answer is derived from the same database that refused the
 * write, so it cannot disagree with it.
 *
 * IT IS ALSO A PREFLIGHT. Called before a batch rather than after a failure,
 * the same function refuses the write with the same sentence, so a row that
 * cannot land is reported precisely instead of being thrown at SQLite to see
 * what happens.
 */
import type { Client, InStatement } from '@libsql/client/web';

type Stmt = Extract<InStatement, { sql: string }>;

/** One foreign key: a column on a table, and the column it must be found in. */
export interface ForeignKeyRule {
  readonly table: string;
  readonly column: string;
  readonly referencesTable: string;
  readonly referencesColumn: string;
}

/**
 * Every foreign key an importer can violate, from the operator's schema.
 *
 * Only the tables the importers write are listed, because those are the only
 * statements this ever inspects. A key added to one of these tables and not
 * added here is not a silent hole: the describer simply falls back to saying
 * it could not identify the key, which is what the old message already said.
 */
export const IMPORT_FOREIGN_KEYS: readonly ForeignKeyRule[] = [
  {
    table: 'purchase_orders',
    column: 'affiliate_id',
    referencesTable: 'affiliates',
    referencesColumn: 'affiliate_id',
  },
  {
    table: 'purchase_orders',
    column: 'business_unit_id',
    referencesTable: 'business_units',
    referencesColumn: 'business_unit_id',
  },
  {
    table: 'purchase_order_lines',
    column: 'purchase_order_id',
    referencesTable: 'purchase_orders',
    referencesColumn: 'purchase_order_id',
  },
  {
    table: 'purchase_order_lines',
    column: 'product_id',
    referencesTable: 'products',
    referencesColumn: 'product_id',
  },
  {
    table: 'sales_orders',
    column: 'affiliate_id',
    referencesTable: 'affiliates',
    referencesColumn: 'affiliate_id',
  },
  {
    table: 'sales_orders',
    column: 'account_id',
    referencesTable: 'accounts',
    referencesColumn: 'account_id',
  },
  {
    table: 'sales_order_lines',
    column: 'sales_order_id',
    referencesTable: 'sales_orders',
    referencesColumn: 'sales_order_id',
  },
  {
    table: 'sales_order_lines',
    column: 'product_id',
    referencesTable: 'products',
    referencesColumn: 'product_id',
  },
  {
    table: 'accounts',
    column: 'country_id',
    referencesTable: 'countries',
    referencesColumn: 'country_id',
  },
  {
    table: 'accounts',
    column: 'affiliate_id',
    referencesTable: 'affiliates',
    referencesColumn: 'affiliate_id',
  },
  {
    table: 'products',
    column: 'product_category_id',
    referencesTable: 'product_categories',
    referencesColumn: 'product_category_id',
  },
  {
    table: 'product_categories',
    column: 'product_group_id',
    referencesTable: 'product_groups',
    referencesColumn: 'product_group_id',
  },
];

/** A value an INSERT was about to write, with the column it was going into. */
export interface WriteValue {
  readonly table: string;
  readonly column: string;
  readonly value: unknown;
}

/**
 * Read the column/value pairs out of an INSERT.
 *
 * The VALUES list is matched slot by slot against the column list, so a
 * literal `NULL` in the statement consumes no argument. Getting that wrong
 * shifts every value one column to the left, which is a very convincing way
 * to report the wrong culprit; the diagnostic that found the original fault
 * made exactly that mistake before it was corrected.
 *
 * Anything that is not a single-row INSERT with a literal VALUES list is
 * skipped rather than guessed at.
 */
export function writeValuesOf(statement: Stmt): WriteValue[] {
  const insert = /INSERT(?:\s+OR\s+\w+)?\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/is.exec(
    statement.sql,
  );
  if (insert === null) return [];
  const table = insert[1] ?? '';
  const columns = (insert[2] ?? '').split(',').map((c) => c.trim());
  const values = /VALUES\s*\(([^)]*)\)/is.exec(statement.sql)?.[1];
  if (values === undefined) return [];
  const slots = values.split(',').map((v) => v.trim());
  const args = statement.args ?? [];
  const found: WriteValue[] = [];
  let argIndex = 0;
  slots.forEach((slot, index) => {
    const column = columns[index];
    if (slot === '?') {
      const value = (args as unknown[])[argIndex];
      argIndex += 1;
      if (column !== undefined) found.push({ table, column, value });
    } else if (column !== undefined) {
      found.push({ table, column, value: slot.toLowerCase() === 'null' ? null : slot });
    }
  });
  return found;
}

/** A foreign key value that is not present in the table it points at. */
export interface ForeignKeyBreach {
  readonly rule: ForeignKeyRule;
  readonly value: string;
}

/**
 * Every foreign key value in these statements that its referenced table does
 * not contain.
 *
 * A NULL is never a breach: a nullable foreign key holding NULL is the
 * absence of a reference, which is exactly what a Group-wide purchase order
 * with no affiliate is.
 */
export async function findForeignKeyBreaches(
  db: Client,
  statements: readonly Stmt[],
): Promise<ForeignKeyBreach[]> {
  const wanted = new Map<string, { rule: ForeignKeyRule; values: Set<string> }>();
  for (const statement of statements) {
    for (const write of writeValuesOf(statement)) {
      if (write.value === null || write.value === undefined) continue;
      const rule = IMPORT_FOREIGN_KEYS.find(
        (candidate) => candidate.table === write.table && candidate.column === write.column,
      );
      if (rule === undefined) continue;
      const key = `${rule.table}.${rule.column}`;
      const entry = wanted.get(key) ?? { rule, values: new Set<string>() };
      entry.values.add(String(write.value));
      wanted.set(key, entry);
    }
  }

  const breaches: ForeignKeyBreach[] = [];
  for (const { rule, values } of wanted.values()) {
    for (const value of values) {
      // One statement per value rather than an IN list: the set is a handful
      // of values from a single failed transaction, and a parameterised
      // lookup per value keeps this free of SQL assembled from data.
      const found = await db.execute({
        sql: `SELECT 1 AS present FROM ${rule.referencesTable}
              WHERE ${rule.referencesColumn} = ? LIMIT 1`,
        args: [value],
      });
      if (found.rows[0] === undefined) breaches.push({ rule, value });
    }
  }
  return breaches;
}

/** The sentence for one breach. The whole point of this module. */
export function describeBreach(breach: ForeignKeyBreach): string {
  const { rule, value } = breach;
  return (
    `${rule.table}.${rule.column} = '${value}' ` +
    `is not a ${rule.referencesTable}.${rule.referencesColumn}`
  );
}

/**
 * The message for a write that a foreign key refused.
 *
 * Where the breach can be identified, the message names the table, the
 * column and the value, and nothing else is needed to fix it. Where it
 * cannot — a key this module does not know, or a failure that was not a
 * foreign key at all — the original error is passed through unchanged rather
 * than replaced by a confident guess.
 */
export async function describeWriteFailure(
  db: Client,
  statements: readonly Stmt[],
  error: unknown,
): Promise<string> {
  const raw = String(error);
  if (!/FOREIGN KEY constraint failed/i.test(raw)) return raw;
  let breaches: ForeignKeyBreach[] = [];
  try {
    breaches = await findForeignKeyBreaches(db, statements);
  } catch {
    // The describer must never be the reason a failure is lost. If asking
    // the database fails too, the caller still gets the original error.
    return raw;
  }
  if (breaches.length === 0) return raw;
  return `${raw} (${breaches.map(describeBreach).join('; ')})`;
}

/**
 * The preflight: refuse before the write, with the same sentence.
 *
 * Returns null when every foreign key value in the statements resolves.
 */
export async function preflightForeignKeys(
  db: Client,
  statements: readonly Stmt[],
): Promise<string | null> {
  const breaches = await findForeignKeyBreaches(db, statements);
  if (breaches.length === 0) return null;
  return breaches.map(describeBreach).join('; ');
}
