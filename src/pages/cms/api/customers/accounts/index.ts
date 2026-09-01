/**
 * GET and POST /api/customers/accounts on cms.murikah.com.
 *
 * GET filters, searches, sorts and paginates in the database, with the Build
 * Prompt 07 scope predicate as the first clause of the WHERE. The total the
 * response carries is counted through the same predicate, so a count can never
 * report a record the caller cannot open.
 *
 * POST creates. Three fields are required: name, type and country. An Oracle
 * customer code is never one of them, because a prospect has no Oracle master
 * record yet and demanding one only produces invented codes.
 */
import type { APIRoute } from 'astro';
import {
  requireAccountsManage,
  requireAccountsView,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { readAccountQuery, validateAccount } from '../../../../../lib/cms/admin/accountInput.ts';
import { createAccount, listAccounts } from '../../../../../lib/cms/repos/accountAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireAccountsView(context);
  if (!auth.ok) return auth.response;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const page = await listAccounts(
      connection.db,
      auth.principal.user.userId,
      readAccountQuery(context.url.searchParams),
    );
    return ok(page);
  } catch (error) {
    return serverError('customers.accounts.list', error);
  }
};

export const POST: APIRoute = async (context) => {
  const auth = requireAccountsManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateAccount(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await createAccount(
      connection.db,
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value, 201) : failure(result);
  } catch (error) {
    return serverError('customers.accounts.create', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or POST');
