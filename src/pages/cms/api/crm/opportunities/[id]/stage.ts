/**
 * POST /api/crm/opportunities/{id}/stage on cms.murikah.com.
 *
 * The only way an opportunity changes stage or status. The payload states the
 * stage the caller believes is current; a stale belief is a 409, decided
 * inside the transaction, so two simultaneous moves cannot both apply and a
 * loser cannot leave a phantom history row.
 *
 * Marking the account CUSTOMER on a win crosses a module boundary, so that
 * flag additionally requires the accounts permission, checked here.
 */
import type { APIRoute } from 'astro';
import { requireOpportunitiesEdit, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { canManageAccounts } from '../../../../../../lib/cms/permissions.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateStageMove } from '../../../../../../lib/cms/admin/opportunityInput.ts';
import { moveStage } from '../../../../../../lib/cms/repos/opportunityAdmin.ts';
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
  const auth = requireOpportunitiesEdit(context);
  if (!auth.ok) return auth.response;
  const parsed = validateStageMove(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  if (parsed.value.markAccountCustomer && !canManageAccounts(auth.principal.user.permissions)) {
    return invalid([
      {
        field: 'markAccountCustomer',
        message:
          'Changing the account type needs the customer management permission. The win can still be recorded without it.',
      },
    ]);
  }

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await moveStage(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.opportunities.stage', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
