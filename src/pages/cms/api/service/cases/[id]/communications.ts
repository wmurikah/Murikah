/**
 * GET and POST /api/service/cases/{id}/communications on cms.murikah.com.
 *
 * The internal view: all three directions. The portal never calls this
 * endpoint; its own read goes through portalCommunications, whose SQL
 * excludes INTERNAL rows before they exist in any response.
 *
 * A first qualifying outbound sets first_response_at in the same transaction,
 * by the exported QUALIFYING_FIRST_RESPONSE rule that phase 15 also reads.
 */
import type { APIRoute } from 'astro';
import {
  requireCasesView,
  requireCasesManage,
  writeContext,
} from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateCommunication } from '../../../../../../lib/cms/admin/serviceInput.ts';
import {
  addCommunication,
  listCommunications,
} from '../../../../../../lib/cms/repos/serviceAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireCasesView(context);
  if (!auth.ok) return auth.response;
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const list = await listCommunications(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
    );
    return list === null ? notFound('That case could not be found.') : ok({ items: list });
  } catch (error) {
    return serverError('service.cases.communications.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireCasesManage(context);
  if (!auth.ok) return auth.response;
  const parsed = validateCommunication(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await addCommunication(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok({ items: result.value }) : failure(result);
  } catch (error) {
    return serverError('service.cases.communications.add', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
