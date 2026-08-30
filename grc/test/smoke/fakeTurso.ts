/**
 * A minimal in-process Turso (libsql over HTTP) stand-in for the smoke test.
 *
 * The Worker's GRC data layer speaks the Hrana v2 pipeline protocol over HTTP
 * (`@libsql/client/web` posts JSON to `<base>/v2/pipeline`). This module serves
 * that protocol from a `node:sqlite` in-memory database, so the built worker can
 * run locally against a throwaway database with no Turso credentials and no
 * network. The tables are generated from the ground-truth dictionary
 * `grc/db/schema.md` (the same source as the typed column layer), so the smoke
 * database always matches the schema the code is compiled against.
 *
 * Only what the client actually sends is implemented: `execute`, `batch` (with
 * condition evaluation), `store_sql`/`close_sql`, `sequence`, `get_autocommit`
 * and `close`. Anything else returns a protocol error, which the smoke test
 * surfaces as a failure rather than hiding it.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';

interface HranaValue {
  type: 'null' | 'integer' | 'float' | 'text' | 'blob';
  value?: string | number;
  base64?: string;
}

interface HranaStmt {
  sql?: string;
  sql_id?: number;
  args?: HranaValue[];
  named_args?: { name: string; value: HranaValue }[];
  want_rows?: boolean;
}

interface HranaBatchCond {
  type: 'ok' | 'error' | 'not' | 'and' | 'or' | 'is_autocommit';
  step?: number;
  cond?: HranaBatchCond;
  conds?: HranaBatchCond[];
}

interface HranaBatchStep {
  condition?: HranaBatchCond;
  stmt: HranaStmt;
}

interface HranaRequest {
  type: string;
  stmt?: HranaStmt;
  batch?: { steps: HranaBatchStep[] };
  sql_id?: number;
  sql?: string;
}

interface StmtResult {
  cols: { name: string; decltype: null }[];
  rows: HranaValue[][];
  affected_row_count: number;
  last_insert_rowid: string | null;
}

interface HranaError {
  message: string;
  code: string;
}

type StreamResult =
  | { type: 'ok'; response: Record<string, unknown> }
  | { type: 'error'; error: HranaError };

/** Reads the table dictionary out of grc/db/schema.md (same grammar as gen-columns). */
export function parseSchema(schemaMdPath: string): Map<string, string[]> {
  const text = readFileSync(schemaMdPath, 'utf8');
  const rowRe = /^- \*\*([a-z_][a-z0-9_]*)\*\*:\s*(.+?)\s*$/;
  const tables = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const m = rowRe.exec(line);
    if (!m) continue;
    const columns = m[2]
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    if (columns.length === 0) throw new Error(`table ${m[1]} has no columns in schema.md`);
    tables.set(m[1], columns);
  }
  if (tables.size === 0) throw new Error(`no tables parsed from ${schemaMdPath}`);
  return tables;
}

/**
 * The constraints the generated smoke schema carries.
 *
 * `grc/db/schema.md` is a column dictionary and records no keys, so every smoke
 * table used to be created with bare untyped columns. That is why a foreign-key
 * violation on the role save passed the smoke test and shipped (audit finding
 * AC-06): a database that enforces nothing cannot refuse anything. These three
 * tables declare what the live schema is known to enforce, so the same write the
 * live database refuses is refused here too.
 *
 * The set is deliberately narrow rather than a guess at the whole live schema:
 * an invented constraint would fail the smoke test on a write the live database
 * accepts, which is a worse failure than the one being fixed. Add to it only
 * where the live schema is known, not where it is assumed.
 *
 * `node:sqlite` enforces foreign keys by default, and the worker's connection
 * runs `PRAGMA foreign_keys = ON` besides (`src/lib/grc/db.ts`), so a declared
 * reference bites in both directions: from the seed and from the worker.
 */

/** Parent columns a reference resolves against. SQLite needs them unique. */
const PRIMARY_KEYS: Record<string, string> = {
  organizations: 'organization_id',
  roles: 'role_code',
  permission_modules: 'module_code',
  permission_actions: 'action_code',
  storage_connections: 'connection_id',
  // Migration 006: a requirement's rounds are keyed by their own id, and the
  // trail is only ever read for one requirement at a time.
  requirement_submissions: 'submission_id',
  work_paper_requirements: 'requirement_id',
};

/** `table.column` to the `parent(column)` it references. */
const FOREIGN_KEYS: Record<string, Record<string, string>> = {
  config: { organization_id: 'organizations(organization_id)' },
  // The permission model's references: three to its own reference tables (the
  // constraint the role save violated for every role, every time), and the
  // organisation the grants belong to since the matrix became tenant data.
  role_permissions: {
    organization_id: 'organizations(organization_id)',
    role_code: 'roles(role_code)',
    module_code: 'permission_modules(module_code)',
    action_code: 'permission_actions(action_code)',
  },
  // Build Prompt 51: a storage connection belongs to exactly one organisation,
  // and the reference is what makes a row for a non-existent tenant impossible.
  storage_connections: { organization_id: 'organizations(organization_id)' },
  // Migration 006: an owner row and a round both belong to a requirement that
  // exists. An orphan round is a trail that reads as somebody else's, which is
  // exactly the write the live schema refuses and this must refuse too.
  requirement_owners: {
    requirement_id: 'work_paper_requirements(requirement_id)',
  },
  requirement_submissions: {
    requirement_id: 'work_paper_requirements(requirement_id)',
    organization_id: 'organizations(organization_id)',
  },
};

/**
 * Column defaults, where the live schema declares one. A NOT NULL column with a
 * default must carry it here too, or the smoke database is stricter than the
 * live one and refuses an insert the live database accepts: a false failure is
 * worse than the one the constraints were added to catch.
 */
const DEFAULTS: Record<string, Record<string, string>> = {
  // Migration 002: added with a default, so existing rows and any insert that
  // omits it mean "not confined".
  role_permissions: { scope_to_affiliate: '0' },
  // Migration 006: the first answer to a requirement is round one.
  requirement_submissions: { round_number: '1' },
  // Migration 003: likewise, an affiliate is not the Group unless said to be.
  affiliates: { is_group: '0' },
  // Migration 004: a new connection is inactive and untested until an
  // administrator tests it and chooses it.
  storage_connections: { is_active: '0', status: "'pending'" },
};

/** Columns a row cannot be written without. */
const NOT_NULL: Record<string, string[]> = {
  role_permissions: [
    'organization_id',
    'role_code',
    'module_code',
    'action_code',
    'is_allowed',
    'scope_to_affiliate',
  ],
  permission_modules: ['module_code'],
  permission_actions: ['action_code'],
  affiliates: ['is_group'],
  storage_connections: ['organization_id', 'provider', 'status', 'is_active'],
  // Migration 006: a round with no requirement, no organisation or no number is
  // not a round of anything.
  requirement_owners: ['requirement_id', 'user_id'],
  requirement_submissions: ['requirement_id', 'organization_id', 'round_number'],
};

/** Creates every dictionary table (untyped columns; SQLite is typeless) plus the FTS index. */
export function createTables(db: DatabaseSync, tables: Map<string, string[]>): void {
  for (const [name, columns] of tables) {
    const defs = columns.map((c) => {
      let def = c;
      if (PRIMARY_KEYS[name] === c) def += ' PRIMARY KEY';
      else if (NOT_NULL[name]?.includes(c)) def += ' NOT NULL';
      const fallback = DEFAULTS[name]?.[c];
      if (fallback !== undefined) def += ` DEFAULT ${fallback}`;
      const reference = FOREIGN_KEYS[name]?.[c];
      if (reference) def += ` REFERENCES ${reference}`;
      return def;
    });
    db.exec(`CREATE TABLE ${name} (${defs.join(', ')})`);
  }
  // Migration 004's two indexes. The partial one is a real constraint, not a
  // performance hint: it is what makes "the organisation's active storage
  // provider" a single answer, so the smoke database must carry it or a bug
  // that leaves two active rows would pass here and fail in production.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_connections_org_provider
       ON storage_connections (organization_id, provider)`,
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_connections_one_active
       ON storage_connections (organization_id) WHERE is_active = 1`,
  );
  // The external-content full-text index over work papers, maintained by the
  // work-papers repository on create, edit and delete.
  db.exec(
    `CREATE VIRTUAL TABLE work_papers_fts USING fts5(
       observation_title, observation_description, recommendation,
       content='work_papers')`,
  );
  // The worker turns foreign keys on for every connection (src/lib/grc/db.ts);
  // node:sqlite leaves them off, so without this the references declared above
  // would be documentation rather than a test.
  db.exec('PRAGMA foreign_keys = ON');
}

function toSqliteArg(v: HranaValue): null | number | bigint | string | Uint8Array {
  switch (v.type) {
    case 'null':
      return null;
    case 'integer': {
      const big = BigInt(String(v.value));
      return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(big)
        : big;
    }
    case 'float':
      return Number(v.value);
    case 'text':
      return String(v.value);
    case 'blob':
      return new Uint8Array(Buffer.from(String(v.base64 ?? ''), 'base64'));
    default:
      throw new Error(`unsupported hrana value type ${String(v.type)}`);
  }
}

function toHranaValue(v: unknown): HranaValue {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? { type: 'integer', value: String(v) }
      : { type: 'float', value: v };
  }
  if (v instanceof Uint8Array) return { type: 'blob', base64: Buffer.from(v).toString('base64') };
  return { type: 'text', value: String(v) };
}

const READER_RE = /^\s*(select|with|values|pragma|explain)\b/i;

export class FakeTursoServer {
  readonly db: DatabaseSync;
  private server: Server | null = null;
  private storedSql = new Map<number, string>();
  private inTransaction = false;
  /** Every statement executed, for debugging a failed smoke run. */
  readonly log: string[] = [];

  constructor(schemaMdPath: string) {
    this.db = new DatabaseSync(':memory:');
    createTables(this.db, parseSchema(schemaMdPath));
  }

  /** Binds to an ephemeral 127.0.0.1 port and returns the base URL. */
  async listen(): Promise<string> {
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || !req.url || !/\/v2\/pipeline$/.test(req.url)) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body: { requests?: HranaRequest[] };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            requests?: HranaRequest[];
          };
        } catch {
          res.writeHead(400).end();
          return;
        }
        const results = (body.requests ?? []).map((r) => this.handleRequest(r));
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ baton: null, base_url: null, results }));
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no listen address');
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.db.close();
  }

  private handleRequest(request: HranaRequest): StreamResult {
    try {
      switch (request.type) {
        case 'execute': {
          const result = this.runStmt(request.stmt ?? {});
          return { type: 'ok', response: { type: 'execute', result } };
        }
        case 'batch':
          return { type: 'ok', response: { type: 'batch', result: this.runBatch(request.batch) } };
        case 'store_sql':
          this.storedSql.set(request.sql_id ?? 0, request.sql ?? '');
          return { type: 'ok', response: { type: 'store_sql' } };
        case 'close_sql':
          this.storedSql.delete(request.sql_id ?? 0);
          return { type: 'ok', response: { type: 'close_sql' } };
        case 'sequence': {
          this.db.exec(request.sql ?? '');
          return { type: 'ok', response: { type: 'sequence' } };
        }
        case 'get_autocommit':
          return {
            type: 'ok',
            response: { type: 'get_autocommit', is_autocommit: !this.inTransaction },
          };
        case 'close':
          return { type: 'ok', response: { type: 'close' } };
        default:
          return {
            type: 'error',
            error: { message: `unsupported request type ${request.type}`, code: 'PROTO' },
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { type: 'error', error: { message, code: 'SQLITE_ERROR' } };
    }
  }

  private resolveSql(stmt: HranaStmt): string {
    if (stmt.sql !== undefined) return stmt.sql;
    const stored = this.storedSql.get(stmt.sql_id ?? -1);
    if (stored === undefined) throw new Error('unknown sql_id');
    return stored;
  }

  private trackTransaction(sql: string): void {
    if (/^\s*begin\b/i.test(sql)) this.inTransaction = true;
    if (/^\s*(commit|rollback|end)\b/i.test(sql)) this.inTransaction = false;
  }

  private runStmt(stmt: HranaStmt): StmtResult {
    const sql = this.resolveSql(stmt);
    this.log.push(sql);
    this.trackTransaction(sql);
    const args = (stmt.args ?? []).map(toSqliteArg);
    const prepared: StatementSync = this.db.prepare(sql);
    if (READER_RE.test(sql) || /\breturning\b/i.test(sql)) {
      const columns = prepared.columns().map((c) => ({ name: c.name ?? '', decltype: null }));
      const rows = prepared
        .all(...args)
        .map((row) => columns.map((c) => toHranaValue((row as Record<string, unknown>)[c.name])));
      return { cols: columns, rows, affected_row_count: 0, last_insert_rowid: null };
    }
    const info = prepared.run(...args);
    return {
      cols: [],
      rows: [],
      affected_row_count: Number(info.changes),
      last_insert_rowid: String(info.lastInsertRowid),
    };
  }

  private runBatch(batch: { steps: HranaBatchStep[] } | undefined): {
    step_results: (StmtResult | null)[];
    step_errors: (HranaError | null)[];
  } {
    const steps = batch?.steps ?? [];
    const stepResults: (StmtResult | null)[] = [];
    const stepErrors: (HranaError | null)[] = [];
    const evaluate = (cond: HranaBatchCond | undefined): boolean => {
      if (!cond) return true;
      switch (cond.type) {
        case 'ok':
          return stepResults[cond.step ?? -1] != null;
        case 'error':
          return stepErrors[cond.step ?? -1] != null;
        case 'not':
          return !evaluate(cond.cond);
        case 'and':
          return (cond.conds ?? []).every(evaluate);
        case 'or':
          return (cond.conds ?? []).some(evaluate);
        case 'is_autocommit':
          return !this.inTransaction;
        default:
          return false;
      }
    };
    for (const step of steps) {
      if (!evaluate(step.condition)) {
        stepResults.push(null);
        stepErrors.push(null);
        continue;
      }
      try {
        stepResults.push(this.runStmt(step.stmt));
        stepErrors.push(null);
      } catch (err) {
        stepResults.push(null);
        stepErrors.push({
          message: err instanceof Error ? err.message : String(err),
          code: 'SQLITE_ERROR',
        });
      }
    }
    return { step_results: stepResults, step_errors: stepErrors };
  }
}
