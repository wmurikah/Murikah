/**
 * POST /api/crm/activities/{id}/reassignment on cms.murikah.com.
 *
 * Changes the owner. The audit row preserves who created the activity and
 * who it moved from; the row itself keeps only current state.
 */
import type { APIRoute } from 'astro';
import { requireSignedIn, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { reassignActivity } from '../../../../../../lib/cms/repos/activityAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;
  const raw = (await readJson(context.request)) as { ownerUserId?: unknown } | null;
  const ownerUserId =
    raw !== null && typeof raw.ownerUserId === 'string' ? raw.ownerUserId.trim() : '';
  if (ownerUserId === '') {
    return invalid([{ field: 'ownerUserId', message: 'Choose the new owner.' }]);
  }
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await reassignActivity(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      ownerUserId,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.activities.reassign', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
