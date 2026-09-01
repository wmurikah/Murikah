/**
 * GET and POST /api/crm/activities on cms.murikah.com.
 *
 * GET with entityType and entityId returns one record's timeline; GET with
 * account returns the account timeline; GET with mine=1 returns the caller's
 * My Work. Every path resolves access through the parent entity before a row
 * is read: there is no way to list activities whose parent the caller may
 * not open.
 *
 * POST creates one. There is no activity permission code: recording that you
 * called a customer is not editing the record, so the write is authorised by
 * the same parent-entity access the read is. What a payload can never do is
 * choose the account column or invent a type; the validator and the
 * repository refuse both.
 */
import type { APIRoute } from 'astro';
import { requireSignedIn, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { readActivityQuery, validateActivity } from '../../../../../lib/cms/admin/activityInput.ts';
import {
  createActivity,
  listAccountActivities,
  listEntityActivities,
  myWork,
} from '../../../../../lib/cms/repos/activityAdmin.ts';
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
  const params = context.url.searchParams;
  const userId = auth.principal.user.userId;
  try {
    if (params.get('mine') === '1') {
      return ok(await myWork(connection.db, userId, new Date()));
    }
    const account = params.get('account');
    if (account !== null && account !== '') {
      const page = await listAccountActivities(
        connection.db,
        userId,
        account,
        readActivityQuery(params),
      );
      return page === null ? notFound('That record could not be found.') : ok(page);
    }
    const entityType = params.get('entityType') ?? '';
    const entityId = params.get('entityId') ?? '';
    const page = await listEntityActivities(
      connection.db,
      userId,
      entityType,
      entityId,
      readActivityQuery(params),
    );
    return page === null ? notFound('That record could not be found.') : ok(page);
  } catch (error) {
    return serverError('crm.activities.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireSignedIn(context);
  if (!auth.ok) return auth.response;
  const parsed = validateActivity(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await createActivity(
      connection.db,
      auth.principal.user.userId,
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.activities.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
