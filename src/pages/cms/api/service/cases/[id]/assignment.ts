/**
 * POST /api/service/cases/{id}/assignment on cms.murikah.com.
 *
 * Team, user, or both, with a reason. Every change writes its history row in
 * the same transaction; the case row never moves alone. Assignment does not
 * grant access: the assignee still reaches the case only through their own
 * scope.
 */
import type { APIRoute } from 'astro';
import { requireCasesReassign, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateAssignment } from '../../../../../../lib/cms/admin/serviceInput.ts';
import { assignCase } from '../../../../../../lib/cms/repos/serviceAdmin.ts';
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
  const auth = requireCasesReassign(context);
  if (!auth.ok) return auth.response;
  const parsed = validateAssignment(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);
  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await assignCase(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('service.cases.assign', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
