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
import { checkCmsHealth, healthHttpStatus } from '../../../../lib/cms/health.ts';

export const prerender = false;

export const GET: APIRoute = async () => {
  const traceId = newTraceId();
  let db;
  try {
    db = await getDb(getCmsEnv());
    const result = await checkCmsHealth(db, traceId);
    return new Response(JSON.stringify({ ...result, traceId }), {
      status: healthHttpStatus(result.status),
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch {
    console.error(`[cms.health] ${traceId} database configuration/connection failed`);
    return new Response(
      JSON.stringify({
        status: 'down',
        checks: [{ name: 'Database', state: 'down', detail: 'Not reachable.' }],
        traceId,
      }),
      {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      },
    );
  } finally {
    db?.close();
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
