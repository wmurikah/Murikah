/**
 * POST /api/service/cases/{id}/status on cms.murikah.com.
 *
 * The only road between statuses, checked against the explicit transition
 * table. Resolving needs a summary; reopening needs a reason; closed never
 * returns to new.
 */
import type { APIRoute } from 'astro';
import { requireCasesManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateStatusChange } from '../../../../../../lib/cms/admin/serviceInput.ts';
import { changeCaseStatus } from '../../../../../../lib/cms/repos/serviceAdmin.ts';
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
  const auth = requireCasesManage(context);
  if (!auth.ok) return auth.response;
  const parsed = validateStatusChange(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await changeCaseStatus(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('service.cases.status', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
