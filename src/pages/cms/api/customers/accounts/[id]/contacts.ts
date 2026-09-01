/**
 * GET and POST /api/customers/accounts/{id}/contacts on cms.murikah.com.
 *
 * The account comes from the path and its scope is checked before a contact is
 * read or written. A contact id is not an access grant; the account behind it
 * decides, every time.
 *
 * THE PORTAL INDICATOR IS FILTERED IN THE QUERY, NOT THE TEMPLATE.
 * A caller without CUSTOMERS.PORTAL_ACCESS.VIEW gets a literal NULL in that
 * column, so no portal state reaches the response body at all. Hiding it in the
 * interface would leave it in the JSON for anyone who opened the network tab.
 */
import type { APIRoute } from 'astro';
import {
  requireAccountsManage,
  requireAccountsView,
  writeContext,
} from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import { validateContact } from '../../../../../../lib/cms/admin/accountInput.ts';
import { createContact, listContacts } from '../../../../../../lib/cms/repos/accountAdmin.ts';
import { canSeePortalAccess } from '../../../../../../lib/cms/permissions.ts';
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
  const auth = requireAccountsView(context);
  if (!auth.ok) return auth.response;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const contacts = await listContacts(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      canSeePortalAccess(auth.principal.user.permissions),
    );
    if (contacts === null) return notFound('That account could not be found.');
    return ok({ items: contacts });
  } catch (error) {
    return serverError('customers.contacts.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireAccountsManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateContact(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await createContact(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value, 201) : failure(result);
  } catch (error) {
    return serverError('customers.contacts.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
