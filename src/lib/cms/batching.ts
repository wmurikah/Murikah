/**
 * One round trip per wave of reads, and a failure that names its section and
 * its statement.
 *
 * WHY THIS EXISTS. `@libsql/client/web` sends one HTTP request per
 * `execute()`, and it does not coalesce concurrent calls: twenty `execute()`
 * calls inside one `Promise.all` are twenty outbound subrequests, not one.
 * That is measured against the real client, not assumed. Cloudflare's Free
 * plan allows 50 subrequests per request, so a page that spends one statement
 * per figure runs out of subrequests before it runs out of figures. The
 * executive dashboard spent 237 and died at the 51st.
 *
 * `batch(stmts, 'read')` sends N statements in ONE request. This module makes
 * that automatic: every `execute()` issued in the same microtask is collected
 * and flushed as a single batch. No repository changes and no SQL changes, so
 * no figure can drift from the module that owns it, which is the property the
 * analytics repositories are built around.
 *
 * ONE QUEUE PER PAGE, NOT ONE PER SECTION. A queue per section would isolate
 * failures but multiply round trips by the number of sections, which is the
 * cost this exists to remove. Instead every statement carries its section
 * label, and the failure path below replays the batch statement by statement:
 * on the happy path a page costs a handful of round trips, and on the failure
 * path only the statements that genuinely fail are rejected, so one bad
 * aggregate cannot take down the panels either side of it.
 *
 * READS ONLY. Nothing on a dashboard writes. A write routed through here would
 * join a `'read'` batch, which libSQL refuses, so the mistake fails loudly
 * rather than silently half-working.
 */
import type { Client, InStatement, ResultSet } from '@libsql/client/web';

/** Which section a statement belonged to, and where in its batch it failed. */
export class SectionQueryError extends Error {
  readonly section: string;
  readonly traceId: string;
  /** 1-based, as counted in the batch that was sent. */
  readonly statementIndex: number;
  readonly statementCount: number;
  /** The first line of the offending SQL. Never the arguments. */
  readonly statementSql: string;

  // Fields are assigned in the body rather than declared as constructor
  // parameter properties: the test runner is `node --experimental-strip-types`,
  // which strips types without transforming, and a parameter property is a
  // transform. It would compile in the worker build and throw
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX in the suite that has to prove this file
  // works, which is the wrong way round.
  constructor(
    section: string,
    traceId: string,
    statementIndex: number,
    statementCount: number,
    statementSql: string,
    cause: unknown,
  ) {
    super(
      `[cms.section:${section}] trace ${traceId}: statement ${statementIndex} of ` +
        `${statementCount} failed: ${statementSql}`,
      { cause },
    );
    this.name = 'SectionQueryError';
    this.section = section;
    this.traceId = traceId;
    this.statementIndex = statementIndex;
    this.statementCount = statementCount;
    this.statementSql = statementSql;
  }
}

/** A short, unguessable id, the shape the CMS API's own trace ids use. */
export function newSectionTraceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The SQL, collapsed to one readable line. Arguments are never included. */
function preview(stmt: InStatement): string {
  const sql = typeof stmt === 'string' ? stmt : stmt.sql;
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}

interface Pending {
  section: string;
  stmt: InStatement;
  resolve: (value: ResultSet) => void;
  reject: (error: unknown) => void;
}

export interface QueryBatcher {
  /** A client whose reads join the shared queue, labelled with `section`. */
  for(section: string): Client;
  /** Subrequests actually spent. This is the number the platform limits. */
  roundTrips(): number;
  /** Statements carried, for reporting the ratio a page achieves. */
  statements(): number;
}

export function createBatcher(db: Client): QueryBatcher {
  let queue: Pending[] = [];
  let scheduled = false;
  let inFlight = false;
  let trips = 0;
  let statements = 0;

  /**
   * ONE BATCH IN FLIGHT AT A TIME, and this is the difference between 119
   * round trips and 11.
   *
   * Coalescing per microtask alone only helps work that is already concurrent.
   * A repository that awaits one statement, then the next, produces one
   * statement per microtask, so each becomes its own batch of one and nothing
   * is saved. Holding the queue shut while a batch is in flight changes that:
   * every statement any chain reaches during that flight accumulates, and they
   * all leave together on the next trip. The cost of a page stops scaling with
   * the number of statements and starts scaling with the depth of its deepest
   * chain, which is a far smaller number and one that does not grow when a
   * panel or an affiliate is added.
   */
  const pump = (): void => {
    if (inFlight) return;
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        void flush();
      });
    }
  };

  const flush = async (): Promise<void> => {
    if (inFlight) return;
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    inFlight = true;
    try {
      await send(batch);
    } finally {
      inFlight = false;
      // Anything that arrived while that batch was in flight goes out as the
      // next one, rather than each arrival paying for its own round trip.
      if (queue.length > 0) pump();
    }
  };

  const send = async (batch: Pending[]): Promise<void> => {
    // One statement is not worth a batch envelope: send it as itself.
    if (batch.length === 1) {
      const only = batch[0]!;
      trips += 1;
      try {
        only.resolve(await db.execute(only.stmt));
      } catch (cause) {
        only.reject(
          new SectionQueryError(only.section, newSectionTraceId(), 1, 1, preview(only.stmt), cause),
        );
      }
      return;
    }

    trips += 1;
    try {
      const results = await db.batch(
        batch.map((p) => p.stmt),
        'read',
      );
      batch.forEach((p, i) => {
        const result = results[i];
        if (result === undefined) {
          p.reject(
            new SectionQueryError(
              p.section,
              newSectionTraceId(),
              i + 1,
              batch.length,
              preview(p.stmt),
              new Error('the batch returned fewer results than statements'),
            ),
          );
          return;
        }
        p.resolve(result);
      });
    } catch {
      // A batch fails as a unit and libSQL does not say which step did it, so
      // the statements are replayed one at a time. Two things come out of
      // that: the failing statement is named rather than guessed at, and every
      // statement that is fine still resolves, so one bad aggregate costs its
      // own panel and not the page. This runs only on the failure path, where
      // the alternative is a stack trace inside the client.
      const id = newSectionTraceId();
      for (const [i, p] of batch.entries()) {
        trips += 1;
        try {
          p.resolve(await db.execute(p.stmt));
        } catch (cause) {
          p.reject(
            new SectionQueryError(p.section, id, i + 1, batch.length, preview(p.stmt), cause),
          );
        }
      }
    }
  };

  const clientFor = (section: string): Client =>
    ({
      ...db,
      // The client every section here is derived from. `resolveScope` caches
      // per client, and each section holds a different wrapper object, so
      // without this the cache would key five sections separately and ask the
      // same question five times over. A global symbol rather than an import,
      // so neither module has to depend on the other.
      [Symbol.for('cms.rootClient')]: db,
      execute: ((stmt: InStatement) =>
        new Promise<ResultSet>((resolve, reject) => {
          statements += 1;
          queue.push({ section, stmt, resolve, reject });
          pump();
        })) as Client['execute'],
    }) as Client;

  return { for: clientFor, roundTrips: () => trips, statements: () => statements };
}

/** One section's outcome: what it loaded, or why it could not. */
export type SectionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly traceId: string; readonly statement: string };

/**
 * Run one section on the shared queue. Never throws.
 *
 * A section that fails comes back with its trace id, so its own panel can say
 * so and quote the id while every other panel still renders. A page-wide `try`
 * around every query is what turned one bad aggregate into a blank dashboard.
 */
export async function runSection<T>(
  batcher: QueryBatcher,
  section: string,
  load: (db: Client) => Promise<T>,
): Promise<SectionResult<T>> {
  try {
    return { ok: true, value: await load(batcher.for(section)) };
  } catch (error) {
    const id = error instanceof SectionQueryError ? error.traceId : newSectionTraceId();
    // The cause goes to the log, the id goes to the screen. The message the
    // user sees is unchanged; this only makes the log say which statement.
    console.error(`[cms.section:${section}] ${id}`, error);
    return {
      ok: false,
      traceId: id,
      statement: error instanceof SectionQueryError ? error.statementSql : 'unknown statement',
    };
  }
}
