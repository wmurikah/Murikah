/**
 * POST /api/crm/leads/{id}/first-contact on cms.murikah.com.
 *
 * Records that somebody has spoken to the lead for the first time. The
 * timestamp is set only when it is NULL, in the UPDATE itself rather than after
 * a read, so two simultaneous calls cannot both write and the second cannot
 * move the moment later.
 *
 * NO SLA CLOCK STOPS HERE. Phase 15 owns SLA measurement and reads this
 * timestamp; this endpoint records a business fact and nothing more.
 */
import type { APIRoute } from 'astro';
import { requireLeadsManage, writeContext } from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { recordFirstContact } from '../../../../../../lib/cms/repos/leadAdmin.ts';
import {
  failure,
  methodNotAllowed,
  ok,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireLeadsManage(context);
  if (!auth.ok) return auth.response;

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await recordFirstContact(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('crm.leads.firstContact', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
