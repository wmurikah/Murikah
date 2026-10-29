/**
 * An isolated test database for the CMS authentication tests.
 *
 * The GRC smoke harness serves the Hrana protocol over HTTP so the built worker
 * can talk to it. These tests do not need the worker: the login flow, the
 * session guard and the repositories all take a client, so an in-process
 * adapter over `node:sqlite` exercises exactly the same SQL with none of the
 * process and port machinery, and a test run costs milliseconds.
 *
 * The adapter implements only the surface this product uses: `execute` with a
 * parameterised statement, and `close`. Anything else throws rather than
 * silently returning nothing, so a repository that starts using a wider API
 * fails loudly here instead of passing a test it never ran.
 *
 * The schema is created from the DDL in ./schema.ts, which is copied verbatim
 * from the operator's hass_cms_turso_v1_FINAL.sql. Foreign keys are ON, and
 * every CHECK constraint is present, so a test proves the code satisfies the
 * real constraints rather than a relaxed copy of them.
 */
import { DatabaseSync } from 'node:sqlite';
import { AUTH_SCHEMA_DDL } from './schema.ts';

interface Stmt {
  sql: string;
  /** Positional or named, exactly as `@libsql/client` accepts them. */
  args?: unknown[] | Record<string, unknown>;
}

/** The slice of the libSQL Client interface the CMS code actually calls. */
export interface TestClient {
  execute(stmt: Stmt | string): Promise<{ rows: Record<string, unknown>[]; rowsAffected: number }>;
  /**
   * The batched write the login flow uses to keep its bookkeeping atomic.
   *
   * It returns the full result of every statement, rows included, because the
   * real client does: `batch(..., 'read')` is how a repository fetches several
   * selection lists in one round trip, and a stub that dropped the rows would
   * make that code untestable while looking like it worked.
   */
  batch(
    stmts: Stmt[],
    mode?: string,
  ): Promise<{ rows: Record<string, unknown>[]; rowsAffected: number }[]>;
  close(): void;
  /** Test-only escape hatch for arrange and assert steps. */
  raw: DatabaseSync;
}

/**
 * Whether a statement returns rows, so this adapter knows to call `all` rather
 * than `run`.
 *
 * The real libSQL client needs no such decision: `execute` returns a result set
 * either way. `node:sqlite` splits the two, and its binding exposes no flag for
 * "does this return rows", so the shape is read from the text.
 *
 * A leading `WITH` counts as a read when nothing in the statement writes. That
 * is what a recursive CTE looks like, which the product catalogue uses to walk
 * a category's ancestors, and without this clause every one of those queries
 * would silently come back with no rows. A `WITH ... INSERT` or `WITH ...
 * DELETE` falls to the write path, which is the safe direction to be wrong in:
 * a write treated as a read still executes, a read treated as a write returns
 * nothing and the failure is loud.
 */
function returnsRows(sql: string): boolean {
  if (/^\s*(select|pragma|explain)/i.test(sql) || /\breturning\b/i.test(sql)) return true;
  if (!/^\s*with\b/i.test(sql)) return false;
  return !/\b(insert|update|delete)\s/i.test(sql.replace(/--[^\n]*/g, ''));
}

export function createTestDb(): TestClient {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(AUTH_SCHEMA_DDL);

  const client: TestClient = {
    async batch(stmts) {
      // A real transaction, so a test proves the batch is atomic rather than
      // merely sequential.
      db.exec('BEGIN');
      try {
        const results = [];
        for (const stmt of stmts) results.push(await client.execute(stmt));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async execute(stmt) {
      const sql = typeof stmt === 'string' ? stmt : stmt.sql;
      const args = typeof stmt === 'string' ? [] : (stmt.args ?? []);
      // node:sqlite rejects booleans and undefined; the worker's client accepts
      // them. Normalise the same way the real driver does.
      const normalise = (a: unknown) => {
        if (a === undefined) return null;
        if (typeof a === 'boolean') return a ? 1 : 0;
        return a;
      };

      // NAMED ARGUMENTS, BECAUSE THE REAL CLIENT TAKES THEM. `execute({sql,
      // args: {since}})` binds `:since`, and several analytics repositories are
      // written that way because a window that appears four times in a UNION
      // would otherwise have to be passed four times in the right order. An
      // adapter that only understood positional arrays made those repositories
      // untestable while looking as though they were covered, which is how a
      // query that had never once been executed reached production.
      const bound = Array.isArray(args)
        ? (args.map(normalise) as (string | number | null | bigint | Uint8Array)[])
        : (Object.fromEntries(
            Object.entries(args as Record<string, unknown>).map(([k, v]) => [k, normalise(v)]),
          ) as never);
      const call = (prepared: ReturnType<DatabaseSync['prepare']>, method: 'all' | 'run') =>
        Array.isArray(bound)
          ? (prepared[method] as (...a: unknown[]) => unknown)(...bound)
          : (prepared[method] as (...a: unknown[]) => unknown)(bound);

      if (returnsRows(sql)) {
        const rows = call(db.prepare(sql), 'all') as unknown as Record<string, unknown>[];
        return { rows, rowsAffected: 0 };
      }
      const result = call(db.prepare(sql), 'run') as { changes?: number };
      return { rows: [], rowsAffected: Number(result.changes ?? 0) };
    },
    close() {
      db.close();
    },
    raw: db,
  };
  return client;
}

/** Rows from an arbitrary query, for assertions. */
export function query(
  client: TestClient,
  sql: string,
  ...args: unknown[]
): Record<string, unknown>[] {
  return client.raw.prepare(sql).all(...(args as never[])) as unknown as Record<string, unknown>[];
}
