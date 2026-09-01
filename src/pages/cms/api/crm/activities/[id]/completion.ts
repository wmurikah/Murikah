/**
 * POST /api/crm/activities/{id}/completion on cms.murikah.com.
 *
 * Sets completed_at, once. A second completion returns the row as it stands
 * rather than moving the timestamp: when the work was done is a fact.
 */
import type { APIRoute } from 'astro';
import { requireSignedIn, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { completeActivity } from '../../../../../../lib/cms/repos/activityAdmin.ts';
import {
  failure,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;
  const raw = (await readJson(context.request)) as { outcome?: unknown } | null;
  const outcome =
    raw !== null && typeof raw.outcome === 'string' && raw.outcome.trim() !== ''
      ? raw.outcome.trim()
      : null;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await completeActivity(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      outcome,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.activities.complete', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
