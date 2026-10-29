/**
 * THE TENANT RULE. This file is the whole security model of the portal.
 *
 * Every portal query is constrained by the account identifiers derived here,
 * SERVER-SIDE, from the authenticated membership. An account identifier that
 * arrives from a browser names nothing until it has been checked against
 * this list, and a single query that forgets to call `portalScope` is a
 * cross-customer data leak.
 *
 * AUTHENTICATION ALONE GRANTS NOTHING.
 * An external user needs three things at once: a user record that is ACTIVE
 * and EXTERNAL, an ACTIVE `customer_portal_memberships` row, and that
 * membership's `account_id`. A suspended membership, a revoked one and an
 * invitation that was never accepted all grant exactly nothing, and so does
 * a valid session belonging to an internal employee.
 *
 * THE SAME ANSWER FOR "NOT YOURS" AND "DOES NOT EXIST".
 * `/portal/orders/SOMEONE-ELSES-ORDER` and `/portal/orders/NONSENSE` return
 * the identical response. A different error, a different status code or a
 * different message for the two would confirm that the first one exists,
 * which is itself the leak. Every reader below returns null, and every
 * endpoint turns null into one not-found.
 */
import type { Client } from '@libsql/client/web';
import type { CmsIdentity } from '../repos/identity.ts';

export interface PortalScope {
  /** The accounts this caller may see. Never empty when `ok` is true. */
  accountIds: string[];
  /** The account currently in context, for a customer with several. */
  activeAccountId: string;
  memberships: { accountId: string; accountName: string | null }[];
  contactId: string | null;
  userId: string;
}

export type PortalAccess =
  | { readonly ok: true; readonly scope: PortalScope }
  | { readonly ok: false; readonly reason: 'not_external' | 'no_membership' };

/**
 * The authorised account identifiers for a principal, and nothing else.
 *
 * The requested account is honoured only when it is one the caller actually
 * holds a membership for. A value from the query string that names another
 * customer is not an error to report; it is simply not in the list, and the
 * caller falls back to their own first membership as though they had asked
 * for nothing. Nothing about the other account is confirmed or denied.
 */
export async function portalScope(
  db: Client,
  user: CmsIdentity,
  requestedAccountId?: string | null,
): Promise<PortalAccess> {
  if (user.userType !== 'EXTERNAL') return { ok: false, reason: 'not_external' };

  // Read the memberships from the database rather than trusting the session
  // payload: a membership revoked a minute ago must stop working now.
  const result = await db.execute({
    sql: `SELECT m.account_id, a.account_name, m.contact_id
          FROM customer_portal_memberships m
          JOIN accounts a ON a.account_id = m.account_id
          JOIN users u ON u.user_id = m.user_id
          WHERE m.user_id = ? AND m.status = 'ACTIVE'
            AND u.status = 'ACTIVE' AND u.user_type = 'EXTERNAL'
          ORDER BY a.account_name`,
    args: [user.userId],
  });
  const memberships = result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      accountId: String(row.account_id),
      accountName: row.account_name === null ? null : String(row.account_name),
      contactId: row.contact_id === null ? null : String(row.contact_id),
    };
  });
  if (memberships.length === 0) return { ok: false, reason: 'no_membership' };

  const accountIds = memberships.map((membership) => membership.accountId);
  // A requested account is used only if it is genuinely theirs. Anything else
  // is ignored in silence rather than refused with a message.
  const requested =
    requestedAccountId !== null &&
    requestedAccountId !== undefined &&
    accountIds.includes(requestedAccountId)
      ? requestedAccountId
      : (accountIds[0] as string);
  const active = memberships.find((membership) => membership.accountId === requested);

  return {
    ok: true,
    scope: {
      accountIds,
      activeAccountId: requested,
      memberships: memberships.map((membership) => ({
        accountId: membership.accountId,
        accountName: membership.accountName,
      })),
      contactId: active?.contactId ?? null,
      userId: user.userId,
    },
  };
}

/**
 * The SQL fragment every portal query pastes into its WHERE clause.
 *
 * It is a bound IN list rather than an interpolated one, and it is built
 * from `scope.accountIds`, which came from the database and never from a
 * request. A query that uses this cannot see another customer's row even if
 * every other clause in it is wrong.
 */
export function accountPredicate(
  scope: PortalScope,
  column: string,
  onlyActive = false,
): { sql: string; args: string[] } {
  const ids = onlyActive ? [scope.activeAccountId] : scope.accountIds;
  return {
    sql: `${column} IN (${ids.map(() => '?').join(', ')})`,
    args: ids,
  };
}

/**
 * The three facts the operator's portal script adds, checked with queries
 * before the portal serves a document or accepts a survey response.
 *
 * Without `customer_visible` there is no way to tell an internal attachment
 * from a customer-facing one, and the honest behaviour is to serve nothing
 * and say why rather than to guess.
 */
export async function verifyPortalTables(db: Client): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  const columns = await db.execute({
    sql: `SELECT name FROM pragma_table_info('entity_attachments')
          WHERE name IN ('customer_visible', 'portal_document_title')`,
    args: [],
  });
  const present = new Set(columns.rows.map((row) => String((row as Record<string, unknown>).name)));
  if (!present.has('customer_visible')) missing.push('entity_attachments.customer_visible');
  if (!present.has('portal_document_title'))
    missing.push('entity_attachments.portal_document_title');

  const table = await db.execute({
    sql: `SELECT name FROM sqlite_master WHERE name = 'survey_invitations'`,
    args: [],
  });
  if (table.rows[0] === undefined) missing.push('survey_invitations');
  return { ok: missing.length === 0, missing };
}

/**
 * Customer-facing language for an internal status.
 *
 * A customer should not have to learn how Hass works internally.
 * WAITING_INTERNAL is our problem and reads as "In progress"; NEW and
 * ASSIGNED are both "Received", because the difference between them is an
 * internal routing detail. Nothing here names a stage, a team or a person.
 */
export const CUSTOMER_CASE_STATUS: Readonly<Record<string, string>> = {
  NEW: 'Received',
  ASSIGNED: 'Received',
  IN_PROGRESS: 'In progress',
  WAITING_CUSTOMER: 'Waiting for your reply',
  WAITING_INTERNAL: 'In progress',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

export function customerCaseStatus(status: string): string {
  return CUSTOMER_CASE_STATUS[status] ?? 'In progress';
}

/**
 * The customer-safe order lifecycle. The internal statuses name our own
 * approval steps, which are not the customer's business and would invite
 * questions about people rather than about their order.
 */
export const CUSTOMER_ORDER_STATUS: Readonly<Record<string, string>> = {
  CREATED: 'Received',
  PENDING_FINANCE: 'Processing',
  PENDING_CREDIT: 'Processing',
  READY: 'Ready',
  INVOICED: 'Invoiced',
  LOADING: 'Loading',
  LOADED: 'Completed',
  CANCELLED: 'Cancelled',
};

export function customerOrderStatus(status: string): string {
  return CUSTOMER_ORDER_STATUS[status] ?? 'Processing';
}

/**
 * How a delay is described to a customer.
 *
 * Transparent about the delay, silent about who is responsible. "This is
 * taking longer than our target time" tells the customer the true thing they
 * need; naming an employee or an internal stage tells them something that is
 * ours to fix and theirs to be annoyed about.
 */
export const DELAY_WORDING = 'This is taking longer than our target time. We are on it.';
