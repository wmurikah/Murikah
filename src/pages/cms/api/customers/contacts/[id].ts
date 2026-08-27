/**
 * PATCH /api/customers/contacts/{id} on cms.murikah.com.
 *
 * Edit a contact, set it primary, or deactivate it. There is no DELETE: a
 * contact that has spoken to this business is history, and `active = 0` is what
 * takes them out of new selection.
 *
 * Setting primary clears every other primary on the same account in the same
 * transaction. The database will not do it: `contacts.is_primary` is a plain
 * flag with a CHECK on the value and nothing at all on how many rows may hold a
 * 1, so two simultaneous requests would otherwise leave two primaries.
 */
import type { APIRoute } from 'astro';
import { requireAccountsManage, writeContext } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateContact } from '../../../../../lib/cms/admin/accountInput.ts';
import { updateContact } from '../../../../../lib/cms/repos/accountAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const PATCH: APIRoute = async (context) => {
  const auth = requireAccountsManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateContact(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect();
  if ('response' in connection) return connection.response;
  try {
    const result = await updateContact(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('customers.contacts.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('PATCH');
