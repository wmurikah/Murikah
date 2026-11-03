/**
 * POST /api/data/unresolved-actors/{id}/create on cms.murikah.com.
 *
 * A user administrator supplies the identity details missing from the source
 * file. The new internal user starts INVITED and is mapped to the source name
 * atomically; the file itself never creates an account.
 */
import type { APIRoute } from 'astro';
import { requireUsersManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateCreateUser } from '../../../../../../lib/cms/admin/userInput.ts';
import { issueInvitation, describeDelivery } from '../../../../../../lib/cms/admin/invitation.ts';
import { getCmsEnv, invitationLinksVisible } from '../../../../../../lib/cms/env.ts';
import { createAndMapUnresolvedActor } from '../../../../../../lib/cms/import/unresolvedUsers.ts';
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
  const auth = requireUsersManage(context);
  if (!auth.ok) return auth.response;

  const body = (await readJson(context.request)) as Record<string, unknown> | null;
  const parsed = validateCreateUser({ ...(body ?? {}), userType: 'INTERNAL' });
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  const ctx = writeContext(context.request, auth.principal);

  try {
    const invitation = await issueInvitation(getCmsEnv().sessionSecret, ctx.now);
    const result = await createAndMapUnresolvedActor(
      connection.db,
      {
        unresolvedActorId: context.params.id ?? '',
        user: parsed.value,
        invitation,
        revalidate: body?.revalidate === true,
      },
      ctx,
    );
    if (!result.ok) {
      if (result.kind === 'user') return failure(result.result);
      return invalid([
        {
          field: 'unresolvedActorId',
          message:
            result.reason === 'not_found_or_resolved'
              ? 'This unresolved name no longer exists or has already been mapped.'
              : 'The user could not be mapped to this source name.',
        },
      ]);
    }
    return ok(
      {
        user: result.user,
        sourceIdentityId: result.sourceIdentityId,
        revalidated: result.revalidated,
        invitation: describeDelivery(result.invitationToken, invitationLinksVisible()),
      },
      201,
    );
  } catch (error) {
    return serverError('data.unresolvedActors.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
