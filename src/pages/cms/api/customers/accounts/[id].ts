/**
 * GET and PATCH /api/customers/accounts/{id} on cms.murikah.com.
 *
 * Both run through the scope predicate. An account outside the caller's scope
 * answers 404, the same as one that does not exist: the two are deliberately
 * indistinguishable, so a probe cannot use the difference to discover that a
 * Uganda customer exists.
 *
 * GET returns the account and its counts in one response. The counts for
 * modules that do not exist yet are null, not zero, and the interface reads
 * "Not available": a zero would be a claim that this customer has no open
 * cases, which is a statement about the business rather than about the build.
 */
import type { APIRoute } from 'astro';
import {
  requireAccountsManage,
  requireAccountsView,
  writeContext,
} from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateAccount } from '../../../../../lib/cms/admin/accountInput.ts';
import {
  accountCounts,
  getAccount,
  updateAccount,
} from '../../../../../lib/cms/repos/accountAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../lib/cms/errors.ts';

export const prerender = false;

export const GET: APIRoute = async (context) => {
  const auth = requireAccountsView(context);
  if (!auth.ok) return auth.response;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const id = context.params.id ?? '';
    const account = await getAccount(connection.db, auth.principal.user.userId, id);
    if (account === null) return notFound('That account could not be found.');
    return ok({ account, counts: await accountCounts(connection.db, id) });
  } catch (error) {
    return serverError('customers.accounts.get', error);
  }
};

export const PATCH: APIRoute = async (context) => {
  const auth = requireAccountsManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateAccount(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const result = await updateAccount(
      connection.db,
      auth.principal.user.userId,
      context.params.id ?? '',
      parsed.value,
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('customers.accounts.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or PATCH');
