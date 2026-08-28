/**
 * GET /api/health on cms.murikah.com.
 *
 * EXPOSES NO SENSITIVE DIAGNOSTIC. An unauthenticated caller learns exactly
 * three things: that the application is running, that the database answered,
 * and that the prerequisite scripts are or are not in place. It learns no
 * version, no hostname, no table name, no row count, no configuration and no
 * error text. A health endpoint that leaks a stack trace or a database URL
 * is a reconnaissance endpoint, and it is unauthenticated by definition.
 *
 * The detail behind a failure is logged server-side with a trace identifier
 * and the caller gets the identifier, so an operator can correlate without
 * the internet reading the cause.
 *
 * It is deliberately not behind the session guard: a health check that needs
 * a session cannot tell you the database is down, because resolving the
 * session needs the database.
 */
import type { APIRoute } from 'astro';
import { getCmsEnv } from '../../../../lib/cms/env.ts';
import { getDb } from '../../../../lib/cms/db.ts';
import { newTraceId } from '../../../../lib/cms/errors.ts';
import { methodNotAllowed } from '../../../../lib/cms/admin/respond.ts';

export const prerender = false;

type CheckState = 'ok' | 'degraded' | 'down';

interface Check {
  name: string;
  state: CheckState;
  /** One short sentence. Never an error message from a driver. */
  detail: string;
}

/**
 * The prerequisite scripts, by the fact each one adds.
 *
 * Reported because a database that is up and missing them is a database that
 * will refuse half the application, and "the database is fine" would be a
 * true and useless answer.
 */
const PREREQUISITES: { name: string; sql: string }[] = [
  {
    name: 'SLA runtime tables',
    sql: `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='sla_instances'`,
  },
  {
    name: 'Source completeness columns',
    sql: `SELECT COUNT(*) AS n FROM pragma_table_info('purchase_order_lines') WHERE name='unit_cost'`,
  },
  {
    name: 'Portal visibility',
    sql: `SELECT COUNT(*) AS n FROM pragma_table_info('entity_attachments') WHERE name='customer_visible'`,
  },
  {
    name: 'Audit immutability triggers',
    sql: `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_audit_events%'`,
  },
];

export const GET: APIRoute = async () => {
  const checks: Check[] = [{ name: 'Application', state: 'ok', detail: 'Running.' }];
  let worst: CheckState = 'ok';
  const traceId = newTraceId();

  try {
    const db = await getDb(getCmsEnv());
    await db.execute('SELECT 1');
    checks.push({ name: 'Database', state: 'ok', detail: 'Reachable.' });

    for (const prerequisite of PREREQUISITES) {
      try {
        const result = await db.execute(prerequisite.sql);
        const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
        const present = Number(row?.n ?? 0);
        const expected = prerequisite.name === 'Audit immutability triggers' ? 2 : 1;
        if (present >= expected) {
          checks.push({ name: prerequisite.name, state: 'ok', detail: 'Applied.' });
        } else {
          worst = 'degraded';
          checks.push({
            name: prerequisite.name,
            state: 'degraded',
            // Names the script, which an operator needs and an attacker
            // already knows from the public repository.
            detail: 'Not applied. The operator has not yet run its script.',
          });
        }
      } catch {
        worst = 'degraded';
        checks.push({
          name: prerequisite.name,
          state: 'degraded',
          detail: 'Could not be checked.',
        });
      }
    }
  } catch (error) {
    // The cause goes to the log with the trace id. It never goes to the
    // caller: a driver error can name a table, a column and sometimes a host.
    console.error(`[cms.health] ${traceId}`, error);
    worst = 'down';
    checks.push({ name: 'Database', state: 'down', detail: 'Not reachable.' });
  }

  return new Response(JSON.stringify({ status: worst, checks, traceId }, null, 2), {
    // 503 when the database is down, so an uptime monitor sees a failure
    // rather than a 200 carrying the word "down" in a field it does not
    // read. Degraded is still 200: the application serves.
    status: worst === 'down' ? 503 : 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
