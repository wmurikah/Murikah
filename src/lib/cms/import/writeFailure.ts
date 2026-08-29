/**
 * What a refused write actually was: the table, the constraint, and the
 * values that broke it.
 *
 * WHY THIS EXISTS, FOR THE THIRD TIME. A sales order commit failed in
 * production and the only thing anybody could see was:
 *
 *   The import could not be completed.
 *
 * Before that, a purchase order batch failed three times with
 * "FOREIGN KEY constraint failed" and nothing else, which cost two days and
 * produced ./foreignKeys.ts. That module answers one constraint class. This
 * one answers all four, because the next failure will not be a foreign key.
 *
 * SQLITE'S OWN MESSAGES, MEASURED RATHER THAN GUESSED. Each class has a
 * different shape and only one of them is useless on its own:
 *
 *   UNIQUE constraint failed: sales_order_lines.sales_order_id, sales_order_lines.line_number
 *   NOT NULL constraint failed: sales_orders.account_id
 *   CHECK constraint failed: order_value IS NULL OR order_value >= 0
 *   FOREIGN KEY constraint failed
 *
 * The first three name their table and column, or their expression, and cost
 * nothing to surface: the failure was already carrying the answer and the
 * code was throwing it away. The fourth names nothing, which is why
 * ./foreignKeys.ts has to ask the database which key the values break.
 *
 * WHAT THE USER SEES AND WHAT THE LOG SEES ARE DIFFERENT ON PURPOSE. A
 * constraint message can carry a customer's name or an Oracle code, so the
 * browser gets a general sentence and a trace id. The log gets everything,
 * because the log is where a person goes when the sentence is not enough.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { describeWriteFailure as describeForeignKeyFailure, writeValuesOf } from './foreignKeys.ts';

type Stmt = Extract<InStatement, { sql: string }>;

export type ConstraintKind = 'UNIQUE' | 'NOT NULL' | 'CHECK' | 'FOREIGN KEY' | 'UNKNOWN';

export interface ParsedConstraint {
  readonly kind: ConstraintKind;
  /** Null for FOREIGN KEY, which SQLite does not name, and for UNKNOWN. */
  readonly table: string | null;
  /** The columns SQLite named. Empty for CHECK and FOREIGN KEY. */
  readonly columns: readonly string[];
  /** The CHECK expression, where the failure was a CHECK. */
  readonly expression: string | null;
}

/**
 * Read the constraint out of the driver's error text.
 *
 * Deliberately tolerant about what wraps the message: libSQL prefixes its own
 * `LibsqlBatchError: SQLITE_CONSTRAINT:` and node:sqlite does not, so this
 * matches the constraint sentence wherever it appears rather than anchoring
 * to the start of the string.
 */
export function parseConstraintError(error: unknown): ParsedConstraint | null {
  const raw = String(error instanceof Error ? `${error.name}: ${error.message}` : (error ?? ''));

  const unique = /UNIQUE constraint failed:\s*([^\n)]+)/i.exec(raw);
  if (unique !== null) return columnsOf('UNIQUE', unique[1] ?? '');

  const notNull = /NOT NULL constraint failed:\s*([^\n)]+)/i.exec(raw);
  if (notNull !== null) return columnsOf('NOT NULL', notNull[1] ?? '');

  const check = /CHECK constraint failed:\s*([^\n)]+)/i.exec(raw);
  if (check !== null) {
    const body = (check[1] ?? '').trim();
    // SQLite gives either the constraint's name or, for an unnamed one, the
    // expression itself. A bare identifier that matches nothing else is the
    // table, which is what it reports for a table-level CHECK.
    return {
      kind: 'CHECK',
      table: /^[A-Za-z_][A-Za-z0-9_]*$/.test(body) ? body : null,
      columns: [],
      expression: body,
    };
  }

  if (/FOREIGN KEY constraint failed/i.test(raw)) {
    return { kind: 'FOREIGN KEY', table: null, columns: [], expression: null };
  }
  return null;
}

/** `t.a, t.b` into a table and its columns. */
function columnsOf(kind: ConstraintKind, list: string): ParsedConstraint {
  const parts = list
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const tables = new Set<string>();
  const columns: string[] = [];
  for (const part of parts) {
    const dot = part.lastIndexOf('.');
    if (dot === -1) {
      columns.push(part);
      continue;
    }
    tables.add(part.slice(0, dot));
    columns.push(part.slice(dot + 1));
  }
  return {
    kind,
    table: tables.size === 1 ? [...tables][0]! : null,
    columns,
    expression: null,
  };
}

/** How the constraint is written in the schema, for the log line. */
export function constraintName(parsed: ParsedConstraint): string {
  switch (parsed.kind) {
    case 'UNIQUE':
      return `UNIQUE(${parsed.columns.join(', ')})`;
    case 'NOT NULL':
      return `NOT NULL on ${parsed.columns.join(', ')}`;
    case 'CHECK':
      return `CHECK(${parsed.expression ?? 'unnamed'})`;
    case 'FOREIGN KEY':
      return 'FOREIGN KEY';
    default:
      return 'unknown constraint';
  }
}

/**
 * The values the refused statements were carrying for the named columns.
 *
 * Only the columns the constraint names, and only from statements against the
 * table it names: dumping every argument of a 500-statement batch into a log
 * is how a log stops being read. Where the constraint names no table, as a
 * foreign key does not, this returns nothing and ./foreignKeys.ts answers
 * instead by asking the database.
 */
export function offendingValues(
  statements: readonly Stmt[],
  parsed: ParsedConstraint,
): Record<string, unknown>[] {
  if (parsed.table === null || parsed.columns.length === 0) return [];
  const wanted = new Set(parsed.columns);
  const found: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const statement of statements) {
    const values = writeValuesOf(statement).filter(
      (v) => v.table === parsed.table && wanted.has(v.column),
    );
    if (values.length === 0) continue;
    const record: Record<string, unknown> = {};
    for (const value of values) record[value.column] = value.value;
    const key = JSON.stringify(record);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(record);
    // A batch that broke a constraint usually did it once, and a handful of
    // candidate rows is enough to find it. Bounded so one bad batch cannot
    // write a thousand lines into the log.
    if (found.length >= 5) break;
  }
  return found;
}

export interface WriteFailureReport {
  /** Everything, for the server log. Never for a browser. */
  readonly detail: string;
  readonly kind: ConstraintKind;
  readonly table: string | null;
  readonly constraint: string;
  readonly values: Record<string, unknown>[];
}

/**
 * Everything known about a refused write, in one line a person can act on.
 *
 * A foreign key is delegated to ./foreignKeys.ts, which resolves the value
 * against the table it should have been in; every other class is read
 * straight out of the message, because SQLite already said it.
 */
export async function describeConstraintFailure(
  db: Client,
  statements: readonly Stmt[],
  error: unknown,
): Promise<WriteFailureReport> {
  const parsed = parseConstraintError(error);
  const raw = String(error);

  if (parsed === null) {
    return {
      detail: raw,
      kind: 'UNKNOWN',
      table: null,
      constraint: 'unknown constraint',
      values: [],
    };
  }

  if (parsed.kind === 'FOREIGN KEY') {
    return {
      detail: await describeForeignKeyFailure(db, statements, error),
      kind: 'FOREIGN KEY',
      table: null,
      constraint: 'FOREIGN KEY',
      values: [],
    };
  }

  const values = offendingValues(statements, parsed);
  const rendered =
    values.length === 0
      ? 'the rejected values could not be recovered from the statement'
      : values.map((v) => JSON.stringify(v)).join(', ');
  return {
    detail:
      `${raw} | table=${parsed.table ?? 'unknown'} ` +
      `constraint=${constraintName(parsed)} values=${rendered}`,
    kind: parsed.kind,
    table: parsed.table,
    constraint: constraintName(parsed),
    values,
  };
}

/**
 * Log a refused write, and hand back the trace id the user is shown.
 *
 * The two halves are deliberately different. The log names the table, the
 * constraint and the values; the caller shows a general sentence carrying
 * this id. A person who quotes the id gets the whole story, and a browser
 * never sees a customer's name inside a database error.
 */
export async function logWriteFailure(
  db: Client,
  tag: string,
  traceId: string,
  statements: readonly Stmt[],
  error: unknown,
): Promise<WriteFailureReport> {
  const report = await describeConstraintFailure(db, statements, error);
  console.error(
    `[cms.${tag}] ${traceId} write refused: ${report.detail} ` +
      `(${statements.length} statements in the transaction)`,
  );
  return report;
}
