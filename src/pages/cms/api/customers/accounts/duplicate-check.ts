/**
 * POST /api/customers/accounts/duplicate-check on cms.murikah.com.
 *
 * Answers "does something like this already exist?" before a create. It writes
 * nothing, merges nothing and blocks nothing: it returns candidates for a human
 * to judge, with the signals that matched each one named so the judgement is
 * possible.
 *
 * NEVER MERGE AUTOMATICALLY. Two companies with similar names in one country
 * are common, and an automatic merge of two real customers destroys the history
 * of both. The UNIQUE constraints on `account_code` and `oracle_customer_code`
 * are the hard stop, and they surface as a field message from the create route,
 * not as a 500.
 *
 * The search is scope-filtered like every other read, which has an honest
 * consequence: a caller may create a duplicate of a record they are not allowed
 * to know about. That is the correct trade. The alternative turns this endpoint
 * into a way to confirm that a named customer exists in a country the caller
 * cannot see.
 */
import type { APIRoute } from 'astro';
import { requireAccountsManage } from '../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../lib/cms/admin/crudRoute.ts';
import { validateDuplicateCheck } from '../../../../../lib/cms/admin/accountInput.ts';
import { findDuplicates } from '../../../../../lib/cms/repos/accountAdmin.ts';
import {
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../lib/cms/admin/respond.ts';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireAccountsManage(context);
  if (!auth.ok) return auth.response;

  const parsed = validateDuplicateCheck(await readJson(context.request));
  if (!parsed.ok) return invalid(parsed.errors);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const candidates = await findDuplicates(
      connection.db,
      auth.principal.user.userId,
      parsed.value,
    );
    return ok({ candidates, merged: false });
  } catch (error) {
    return serverError('customers.accounts.duplicateCheck', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('POST');
