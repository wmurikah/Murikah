/**
 * GET /api/performance/sla on cms.murikah.com.
 *
 * The monitor feed. Every call is an entry into the engine, so the sweep
 * runs first: warnings and breaches that came due while nothing was running
 * are settled before the list is read. That is the whole answer to "what
 * detects a breach when a Worker has no always-on process": the next
 * request does, and breached_at records the true target time, not the
 * detection time.
 */
import type { APIRoute } from 'astro';
import { requireSlaDashboard } from '../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../lib/cms/admin/crudRoute.ts';
import { readMonitorQuery } from '../../../../lib/cms/admin/slaInput.ts';
import { listSlaInstances } from '../../../../lib/cms/repos/slaAdmin.ts';
import { sweepDueSlas, verifySlaTables } from '../../../../lib/cms/sla/engine.ts';
import { methodNotAllowed, ok, serverError } from '../../../../lib/cms/admin/respond.ts';
import { apiError } from '../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireSlaDashboard(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const verified = await verifySlaTables(connection.db);
    if (!verified.ok) {
      return apiError(
        'unavailable',
        `The SLA runtime tables are missing: ${verified.missing.join(', ')}. The operator's prerequisite script has not been run against this database.`,
        503,
      );
    }
    const now = new Date();
    await sweepDueSlas(connection.db, now);
    return ok(
      await listSlaInstances(
        connection.db,
        auth.principal.user.userId,
        readMonitorQuery(context.url.searchParams),
        now,
      ),
    );
  } catch (error) {
    return serverError('performance.sla.monitor', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET');
