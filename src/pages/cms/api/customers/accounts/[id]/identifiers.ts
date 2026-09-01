/**
 * GET and PATCH /api/customers/accounts/{id}/identifiers on cms.murikah.com.
 *
 * THE TWO UNIQUE CODES HAVE THEIR OWN ROUTE, AND THAT IS THE WHOLE POINT.
 *
 * `oracle_customer_code` is the key the importer matches an extract row on.
 * Changing it does not change this customer's history; it changes where every
 * FUTURE import lands, and the effect does not appear until the next extract
 * arrives. `account_code` is unique for the same structural reason. Neither
 * belongs in the same submit as a corrected phone number, because the moment
 * they share a form they share a confirmation, and the confirmation for a phone
 * number is no confirmation at all.
 *
 * So: its own route, its own control on screen, its own confirmation, and its
 * own audit event. GET answers the confirmation's question — how many orders
 * currently match this code, and how many extract rows carry it literally —
 * before anything is submitted. PATCH changes the two codes and nothing else.
 *
 * A COLLISION NAMES THE ACCOUNT ALREADY HOLDING IT, rather than returning a
 * constraint error. "Another account already holds that code" tells somebody
 * they cannot proceed and nothing about what to do next; nine times in ten the
 * holder is the record they meant to edit or a duplicate created last year, and
 * either way the next action is to open it.
 */
import type { APIRoute } from 'astro';
import {
  requireAccountsManage,
  requireAccountsView,
  writeContext,
} from '../../../../../../lib/cms/admin/guard.ts';
import { connect } from '../../../../../../lib/cms/admin/crudRoute.ts';
import {
  getAccount,
  oracleCodeUsage,
  updateAccount,
} from '../../../../../../lib/cms/repos/accountAdmin.ts';
import {
  failure,
  invalid,
  methodNotAllowed,
  ok,
  readJson,
  serverError,
} from '../../../../../../lib/cms/admin/respond.ts';
import { notFound } from '../../../../../../lib/cms/errors.ts';
import type { FieldError } from '../../../../../../lib/validation.ts';

export const prerender = false;

/** A code is optional, and where present it is bounded and uppercase-ish. */
const CODE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

function readCode(raw: unknown, field: string, label: string): FieldError | string | null {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const value = String(raw).trim();
  if (!CODE.test(value)) {
    return {
      field,
      message: `A ${label} is up to 64 letters, digits, dots, dashes, slashes or underscores.`,
    };
  }
  return value;
}

export const GET: APIRoute = async (context) => {
  // The CONFIRMATION's own read. It is on the view permission rather than the
  // manage one, because a person deciding whether to ask for a change should be
  // able to see what it would touch.
  const auth = requireAccountsView(context);
  if (!auth.ok) return auth.response;

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const id = context.params.id ?? '';
    const account = await getAccount(connection.db, auth.principal.user.userId, id);
    if (account === null) return notFound('That account could not be found.');
    return ok({
      accountCode: account.accountCode,
      oracleCustomerCode: account.oracleCustomerCode,
      usage: await oracleCodeUsage(connection.db, id, account.oracleCustomerCode),
    });
  } catch (error) {
    return serverError('customers.accounts.identifiers.get', error);
  }
};

export const PATCH: APIRoute = async (context) => {
  const auth = requireAccountsManage(context);
  if (!auth.ok) return auth.response;

  const body = (await readJson(context.request)) as Record<string, unknown>;
  const oracle = readCode(body.oracleCustomerCode, 'oracleCustomerCode', 'Oracle customer code');
  const code = readCode(body.accountCode, 'accountCode', 'account code');
  const problems = [oracle, code].filter(
    (value): value is FieldError => value !== null && typeof value !== 'string',
  );
  if (problems.length > 0) return invalid(problems);

  const connection = await connect(context.locals);
  if ('response' in connection) return connection.response;
  try {
    const id = context.params.id ?? '';
    const before = await getAccount(connection.db, auth.principal.user.userId, id);
    if (before === null) return notFound('That account could not be found.');

    // EVERY OTHER FIELD IS CARRIED THROUGH UNCHANGED, read from the record
    // rather than from the request. This route can only ever change the two
    // codes: a field the caller did not send cannot be blanked by omission, and
    // a field they did send that is not a code is ignored rather than applied.
    const result = await updateAccount(
      connection.db,
      auth.principal.user.userId,
      id,
      {
        accountName: before.accountName,
        accountType: before.accountType,
        accountCode: typeof code === 'string' ? code : null,
        oracleCustomerCode: typeof oracle === 'string' ? oracle : null,
        industry: before.industry,
        segment: before.segment,
        countryId: before.countryId,
        affiliateId: before.affiliateId,
        address: before.address,
        phone: before.phone,
        email: before.email,
        website: before.website,
        taxPin: before.taxPin,
        creditLimit: before.creditLimit,
        creditDays: before.creditDays,
        accountManagerUserId: before.accountManagerUserId,
        customerSince: before.customerSince,
        status: before.status,
      },
      writeContext(context.request, auth.principal),
    );
    return result.ok ? ok(result.value) : failure(result);
  } catch (error) {
    return serverError('customers.accounts.identifiers.update', error);
  }
};

export const ALL: APIRoute = () => methodNotAllowed('GET or PATCH');
