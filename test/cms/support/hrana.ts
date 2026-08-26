/**
 * A minimal in-process Turso (libSQL over HTTP) stand-in for the CMS
 * end-to-end proof.
 *
 * `@libsql/client/web` posts JSON to `<base>/v2/pipeline`, so serving that
 * protocol from a `node:sqlite` in-memory database lets the built worker run
 * locally against a throwaway database with no Turso credentials and no
 * network. That is what makes the section 16 login test a real one: the
 * endpoints, the middleware guard and the bootstrap command all execute
 * unmodified, against the operator's own DDL and seed rows.
 *
 * This mirrors grc/test/smoke/fakeTurso.ts in approach. It is a separate file
 * rather than a reuse because that one builds its tables from GRC's own
 * schema dictionary, and grc/ is fenced.
 *
 * Only what the client actually sends is implemented. Anything else returns a
 * protocol error, so an unimplemented request surfaces as a failure rather than
 * as a silently empty result.
 */
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';

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
/**
 * A batch step's guard. The client wraps a transactional batch as
 * BEGIN, the steps, COMMIT, then a ROLLBACK guarded by "the commit failed", so
 * a server that ran every step unconditionally would roll back a batch it had
 * just committed. Evaluating the conditions is what makes batch() work.
 */
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
  sql?: string;
  sql_id?: number;
}

type SqlValue = string | number | null | bigint | Uint8Array;

function toSql(value: HranaValue): SqlValue {
  switch (value.type) {
    case 'null':
      return null;
    case 'integer':
      return typeof value.value === 'string' ? Number(value.value) : (value.value ?? 0);
    case 'float':
      return Number(value.value ?? 0);
    case 'blob':
      return Buffer.from(value.base64 ?? '', 'base64');
    default:
      return String(value.value ?? '');
  }
}

function fromSql(value: unknown): HranaValue {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'bigint') return { type: 'integer', value: String(value) };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { type: 'integer', value: String(value) }
      : { type: 'float', value };
  }
  if (value instanceof Uint8Array) {
    return { type: 'blob', base64: Buffer.from(value).toString('base64') };
  }
  return { type: 'text', value: String(value) };
}

export class FakeCmsTurso {
  readonly db: DatabaseSync;
  private server: Server | null = null;
  private storedSql = new Map<number, string>();
  private inTransaction = false;

  /** `ddl` is executed as-is: the operator's schema and seed, verbatim. */
  constructor(ddl: string) {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(ddl);
  }

  private runStatement(stmt: HranaStmt): Record<string, unknown> {
    const sql = stmt.sql ?? this.storedSql.get(stmt.sql_id ?? -1) ?? '';
    const args = (stmt.args ?? []).map(toSql);
    for (const named of stmt.named_args ?? []) args.push(toSql(named.value));

    const prepared = this.db.prepare(sql);
    // node:sqlite throws on .all() for a non-returning statement, so the two
    // are dispatched on the statement rather than guessed at.
    const returnsRows = /^\s*(select|pragma|with)/i.test(sql);
    if (returnsRows) {
      const rows = prepared.all(...(args as never[])) as unknown as Record<string, unknown>[];
      const cols = rows[0] ? Object.keys(rows[0]) : [];
      return {
        cols: cols.map((name) => ({ name, decltype: null })),
        rows: rows.map((row) => cols.map((c) => fromSql(row[c]))),
        affected_row_count: 0,
        last_insert_rowid: null,
        replication_index: null,
        rows_read: rows.length,
        rows_written: 0,
        query_duration_ms: 0,
      };
    }
    const result = prepared.run(...(args as never[]));
    return {
      cols: [],
      rows: [],
      affected_row_count: Number(result.changes ?? 0),
      last_insert_rowid: String(result.lastInsertRowid ?? 0),
      replication_index: null,
      rows_read: 0,
      rows_written: Number(result.changes ?? 0),
      query_duration_ms: 0,
    };
  }

  /** Run a batch, honouring each step's condition. */
  private runBatch(steps: HranaBatchStep[]): Record<string, unknown> {
    const stepResults: (Record<string, unknown> | null)[] = [];
    const stepErrors: ({ message: string } | null)[] = [];

    const evaluate = (cond?: HranaBatchCond): boolean => {
      if (!cond) return true;
      switch (cond.type) {
        case 'ok':
          return stepResults[cond.step ?? -1] != null;
        case 'error':
          return stepErrors[cond.step ?? -1] != null;
        case 'not':
          return !evaluate(cond.cond);
        case 'and':
          return (cond.conds ?? []).every((c) => evaluate(c));
        case 'or':
          return (cond.conds ?? []).some((c) => evaluate(c));
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
      const sql = step.stmt.sql ?? this.storedSql.get(step.stmt.sql_id ?? -1) ?? '';
      try {
        const result = this.runStatement(step.stmt);
        if (/^\s*begin/i.test(sql)) this.inTransaction = true;
        if (/^\s*(commit|rollback|end)/i.test(sql)) this.inTransaction = false;
        stepResults.push(result);
        stepErrors.push(null);
      } catch (error) {
        stepResults.push(null);
        stepErrors.push({ message: (error as Error).message });
      }
    }
    return { step_results: stepResults, step_errors: stepErrors };
  }

  private handle(request: HranaRequest): Record<string, unknown> {
    try {
      switch (request.type) {
        case 'execute':
          return {
            type: 'ok',
            response: { type: 'execute', result: this.runStatement(request.stmt ?? {}) },
          };
        case 'batch':
          return {
            type: 'ok',
            response: { type: 'batch', result: this.runBatch(request.batch?.steps ?? []) },
          };
        case 'store_sql':
          this.storedSql.set(request.sql_id ?? 0, request.sql ?? '');
          return { type: 'ok', response: { type: 'store_sql' } };
        case 'close_sql':
          this.storedSql.delete(request.sql_id ?? 0);
          return { type: 'ok', response: { type: 'close_sql' } };
        case 'get_autocommit':
          return { type: 'ok', response: { type: 'get_autocommit', is_autocommit: true } };
        case 'close':
          return { type: 'ok', response: { type: 'close' } };
        default:
          return { type: 'error', error: { message: `unimplemented request: ${request.type}` } };
      }
    } catch (error) {
      return { type: 'error', error: { message: (error as Error).message } };
    }
  }

  /** Binds to an ephemeral 127.0.0.1 port and returns the base URL. */
  async listen(): Promise<string> {
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || !req.url || !/\/v2\/pipeline$/.test(req.url)) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
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
        const results = (body.requests ?? []).map((r) => this.handle(r));
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
    const port = typeof address === 'object' && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  close(): void {
    this.server?.close();
    this.db.close();
  }
}
