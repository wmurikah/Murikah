/**
 * GET and PATCH /api/crm/activities/{id} on cms.murikah.com.
 *
 * The id is not an access grant. The repository fetches the row and then
 * re-resolves access through its parent entity, so arriving here by guessing
 * an id, or from a notification whose rights have since changed, earns the
 * same not-found as a record that never existed.
 */
import type { APIRoute } from 'astro';
import { requireSignedIn, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateActivityPatch } from '../../../../../lib/cms/admin/activityInput.ts';
import { getActivity, updateActivity } from '../../../../../lib/cms/repos/activityAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const activity = await getActivity(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
    );
    return activity === null ? notFound('That activity could not be found.') : ok(activity);
  } catch (error) {
    return serverError('crm.activities.get', error);
  }
};

export const PATCH: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;
  const parsed = validateActivityPatch(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await updateActivity(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.activities.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or PATCH');
