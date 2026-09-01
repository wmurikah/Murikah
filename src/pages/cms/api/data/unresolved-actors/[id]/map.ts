/**
 * POST /api/data/unresolved-actors/{id}/map on cms.murikah.com.
 *
 * Map a source username to an EXISTING user. This endpoint creates nobody:
 * a name in a spreadsheet is not an account, and a genuinely new colleague
 * goes through user administration where an email is mandatory. Mapping a
 * source identity changes who a system attributes work to, so it needs the
 * user administration permission, not the import one.
 */
import type { APIRoute } from 'astro';
import { requireUsersManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { mapUnresolvedActor } from '../../../../../../lib/cms/import/uploadCentre.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;
  const body = (await readJson(context.request)) as Record<string, unknown>;
  const userId = String(body.userId ?? '').trim();
  if (userId === '') {
    return invalid([{ field: 'userId', message: 'Choose the person this name belongs to.' }]);
  }
  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await mapUnresolvedActor(
      connection.db,
      {
        unresolvedActorId: context.params.id ?? '',
        userId,
        revalidate: body.revalidate === true,
      },
      writeContext(context.request, auth.principal),
    );
    if (!result.ok) {
      if (result.reason === 'not_found') return notFound();
      return invalid([{ field: 'userId', message: reasonMessage(result.reason) }]);
    }
    return ok(result);
  } catch (error) {
    return serverError('data.unresolvedActors.map', error);
  }
};

function reasonMessage(reason: string): string {
  if (reason === 'already_resolved') return 'This name has already been mapped.';
  if (reason === 'unknown_user')
    return 'That user does not exist. Create them in user administration first.';
  if (reason === 'inactive_user') return 'That user is not active.';
  return 'The mapping could not be made.';
}

export const ALL: APIRoute = () => methodNotAllowed('POST');
