/**
 * Global search across seven entity types.
 *
 * THE SECURITY FILTER IS IN THE QUERY, NOT AFTER IT. Each entity's search is
 * a separate statement carrying that module's own canonical scope predicate,
 * so an unauthorised row is never in a result set at any point, not even for
 * the instant before something filters it out. Searching everything and
 * hiding rows afterwards would mean the count was briefly right and the
 * database briefly returned another affiliate's order into this worker's
 * memory, and both are the kind of thing that becomes a leak the first time
 * somebody adds a debug log.
 *
 * A MISS AND A REFUSAL ARE INDISTINGUISHABLE. A Kenya user searching a known
 * Uganda document number gets exactly what they get for a number that does
 * not exist: an empty group, the same shape, the same timing characteristics
 * as far as this code controls them. There is no "you may not see this"
 * message anywhere, because that message is itself the leak: it confirms the
 * order exists.
 *
 * NO SEARCH INFRASTRUCTURE. Seven indexed queries against the tables that
 * already exist. If a measurement ever shows that is not enough, that is a
 * decision to escalate, not a package to add.
 */
import type { Client } from '@libsql/client/web';
import { scopedAccounts } from '../repos/accountAdmin.ts';
import { scopedLeads } from '../repos/leadAdmin.ts';
import { scopedOpportunities } from '../repos/opportunityAdmin.ts';
import { scopedCases } from '../repos/serviceAdmin.ts';
import { scopedSalesOrders } from '../repos/soPerformance.ts';
import { scopedPurchaseOrders } from '../repos/poPerformance.ts';
import {
  canViewAccounts,
  canViewLeads,
  canViewOpportunities,
  canViewCases,
  canViewSalesOrders,
  canViewPurchaseOrders,
} from '../permissions.ts';

const text = (v: unknown): string => String(v ?? '');

export const SEARCH_GROUPS = [
  'ACCOUNT',
  'CONTACT',
  'LEAD',
  'OPPORTUNITY',
  'CASE',
  'SALES_ORDER',
  'PURCHASE_ORDER',
] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

export interface SearchHit {
  group: SearchGroup;
  id: string;
  /** The thing a person recognises: a document number, a name, a subject. */
  title: string;
  /**
   * The context that makes the title mean something. A customer without its
   * country, or an order without its customer, is a row a reader has to click
   * to identify, which defeats the point of a search result.
   */
  context: string;
  href: string;
  /** Lower sorts first. See RANK below. */
  rank: number;
}

export interface SearchGroupResult {
  group: SearchGroup;
  label: string;
  hits: SearchHit[];
  /** True where more exist than were returned. */
  more: boolean;
}

export interface SearchResult {
  query: string;
  groups: SearchGroupResult[];
  total: number;
  /** Groups the caller holds no permission for. Named, not silently absent. */
  notPermitted: SearchGroup[];
}

export const GROUP_LABEL: Readonly<Record<SearchGroup, string>> = {
  ACCOUNT: 'Customers',
  CONTACT: 'Contacts',
  LEAD: 'Leads',
  OPPORTUNITY: 'Opportunities',
  CASE: 'Cases',
  SALES_ORDER: 'Sales orders',
  PURCHASE_ORDER: 'Purchase orders',
};

/**
 * The ranking, as four bands rather than a score.
 *
 * Bands, because a score invites tuning and nobody can say what 0.72 means.
 * Four buckets a person can predict: I typed the exact number, I typed the
 * exact code, I typed the beginning of something, or it merely contains what
 * I typed.
 *
 * The consequence the phase names: searching a document number must put that
 * order above a customer whose telephone number contains the same digits.
 * The order's exact identifier match is band 0; the customer's substring
 * match is band 3.
 */
const RANK = { EXACT_ID: 0, EXACT_CODE: 1, PREFIX: 2, CONTAINS: 3 } as const;

/** Two characters is the floor. One character matches most of the database. */
export const MIN_QUERY_LENGTH = 2;
/** Per group, so one noisy group cannot crowd out the others. */
export const GROUP_LIMIT = 8;

/**
 * SQLite LIKE is case-insensitive for ASCII and the columns are not BINARY,
 * so `LIKE` is the right operator. The wildcards in the term itself are
 * escaped so that a customer searching for a literal `%` does not match
 * everything, which would look like a broken search and is a small denial of
 * service against the database.
 */
function likeTerms(query: string): { exact: string; prefix: string; contains: string } {
  const escaped = query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return { exact: query, prefix: `${escaped}%`, contains: `%${escaped}%` };
}

/**
 * One band expression, written once. `column = ?` first so an exact match
 * outranks a prefix on a different column of the same row.
 */
function rankExpression(idColumns: string[], codeColumns: string[], textColumns: string[]): string {
  const exactId = idColumns.map((c) => `${c} = ?`).join(' OR ');
  const exactCode = codeColumns.map((c) => `${c} = ?`).join(' OR ');
  const prefix = [...idColumns, ...codeColumns, ...textColumns]
    .map((c) => `${c} LIKE ? ESCAPE '\\'`)
    .join(' OR ');
  return `CASE
    WHEN ${exactId === '' ? '0' : exactId} THEN ${RANK.EXACT_ID}
    WHEN ${exactCode === '' ? '0' : exactCode} THEN ${RANK.EXACT_CODE}
    WHEN ${prefix} THEN ${RANK.PREFIX}
    ELSE ${RANK.CONTAINS} END`;
}

function matchExpression(columns: string[]): string {
  return columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ');
}

interface GroupQuery {
  group: SearchGroup;
  sql: string;
  args: unknown[];
}

/**
 * Build every group's query. Each is independent, each carries its own scope,
 * and a group the caller has no permission for is not built at all rather
 * than built and discarded.
 */
async function buildQueries(
  db: Client,
  userId: string,
  permissions: readonly string[],
  query: string,
): Promise<{ queries: GroupQuery[]; notPermitted: SearchGroup[] }> {
  const { exact, prefix, contains } = likeTerms(query);
  const queries: GroupQuery[] = [];
  const notPermitted: SearchGroup[] = [];

  // ---- Customers and contacts --------------------------------------------
  if (canViewAccounts(permissions)) {
    const scope = await scopedAccounts(db, userId);
    const idCols = ['a.account_id'];
    const codeCols = ['a.account_code', 'a.oracle_customer_code'];
    const textCols = ['a.account_name'];
    queries.push({
      group: 'ACCOUNT',
      sql: `SELECT a.account_id AS id, a.account_name AS title, a.account_id AS account_id,
              COALESCE(a.account_type, '') AS c1, COALESCE(c.country_name, '') AS c2,
              COALESCE(a.account_code, '') AS c3, a.status AS c4,
              ${rankExpression(idCols, codeCols, textCols)} AS rank
            FROM accounts a
            LEFT JOIN countries c ON c.country_id = a.country_id
            WHERE (${matchExpression([...idCols, ...codeCols, ...textCols])}) AND ${scope.sql}
            ORDER BY rank, a.account_name LIMIT ?`,
      args: [
        ...idCols.map(() => exact),
        ...codeCols.map(() => exact),
        ...[...idCols, ...codeCols, ...textCols].map(() => prefix),
        ...[...idCols, ...codeCols, ...textCols].map(() => contains),
        ...scope.args,
        GROUP_LIMIT + 1,
      ],
    });

    // A contact is visible exactly where its account is. There is no separate
    // contact permission, and inventing one here would be a second answer to
    // a question accountAdmin already answers.
    const contactIdCols = ['ct.contact_id'];
    const contactTextCols = ['ct.full_name', 'ct.email'];
    queries.push({
      group: 'CONTACT',
      sql: `SELECT ct.contact_id AS id, ct.full_name AS title, a.account_id AS account_id,
              COALESCE(ct.job_title, '') AS c1, a.account_name AS c2,
              COALESCE(ct.email, '') AS c3, CASE WHEN ct.active = 1 THEN 'Active' ELSE 'Inactive' END AS c4,
              ${rankExpression(contactIdCols, [], contactTextCols)} AS rank
            FROM contacts ct
            JOIN accounts a ON a.account_id = ct.account_id
            LEFT JOIN countries c ON c.country_id = a.country_id
            WHERE (${matchExpression([...contactIdCols, ...contactTextCols])}) AND ${scope.sql}
            ORDER BY rank, ct.full_name LIMIT ?`,
      args: [
        ...contactIdCols.map(() => exact),
        ...[...contactIdCols, ...contactTextCols].map(() => prefix),
        ...[...contactIdCols, ...contactTextCols].map(() => contains),
        ...scope.args,
        GROUP_LIMIT + 1,
      ],
    });
  } else {
    notPermitted.push('ACCOUNT', 'CONTACT');
  }

  // ---- Leads ---------------------------------------------------------------
  if (canViewLeads(permissions)) {
    const scope = await scopedLeads(db, userId);
    const idCols = ['l.lead_id'];
    const codeCols = ['l.lead_number'];
    const textCols = ['l.title'];
    queries.push({
      group: 'LEAD',
      sql: `SELECT l.lead_id AS id, l.title AS title, COALESCE(l.account_id, '') AS account_id,
              l.lead_number AS c1, COALESCE(a.account_name, 'No customer yet') AS c2,
              l.status AS c3, COALESCE(l.product_interest, '') AS c4,
              ${rankExpression(idCols, codeCols, textCols)} AS rank
            FROM leads l
            LEFT JOIN accounts a ON a.account_id = l.account_id
            WHERE (${matchExpression([...idCols, ...codeCols, ...textCols])}) AND ${scope.sql}
            ORDER BY rank, l.captured_at DESC LIMIT ?`,
      args: [
        exact,
        exact,
        ...[...idCols, ...codeCols, ...textCols].map(() => prefix),
        ...[...idCols, ...codeCols, ...textCols].map(() => contains),
        ...scope.args,
        GROUP_LIMIT + 1,
      ],
    });
  } else {
    notPermitted.push('LEAD');
  }

  // ---- Opportunities -------------------------------------------------------
  if (canViewOpportunities(permissions)) {
    const scope = await scopedOpportunities(db, userId);
    const idCols = ['o.opportunity_id'];
    const codeCols = ['o.opportunity_number'];
    const textCols = ['o.title'];
    queries.push({
      group: 'OPPORTUNITY',
      sql: `SELECT o.opportunity_id AS id, o.title AS title, o.account_id AS account_id,
              o.opportunity_number AS c1, a.account_name AS c2,
              o.status AS c3, COALESCE(ps.stage_name, '') AS c4,
              ${rankExpression(idCols, codeCols, textCols)} AS rank
            FROM opportunities o
            JOIN accounts a ON a.account_id = o.account_id
            LEFT JOIN pipeline_stages ps ON ps.pipeline_stage_id = o.current_stage_id
            WHERE (${matchExpression([...idCols, ...codeCols, ...textCols])}) AND ${scope.sql}
            ORDER BY rank, o.updated_at DESC LIMIT ?`,
      args: [
        exact,
        exact,
        ...[...idCols, ...codeCols, ...textCols].map(() => prefix),
        ...[...idCols, ...codeCols, ...textCols].map(() => contains),
        ...scope.args,
        GROUP_LIMIT + 1,
      ],
    });
  } else {
    notPermitted.push('OPPORTUNITY');
  }

  // ---- Cases ---------------------------------------------------------------
  if (canViewCases(permissions)) {
    const scope = await scopedCases(db, userId);
    const idCols = ['sc.case_id'];
    const codeCols = ['sc.case_number'];
    const textCols = ['sc.subject'];
    queries.push({
      group: 'CASE',
      sql: `SELECT sc.case_id AS id, sc.subject AS title, sc.account_id AS account_id,
              sc.case_number AS c1, a.account_name AS c2,
              sc.status AS c3, sc.priority AS c4,
              ${rankExpression(idCols, codeCols, textCols)} AS rank
            FROM service_cases sc
            JOIN accounts a ON a.account_id = sc.account_id
            WHERE (${matchExpression([...idCols, ...codeCols, ...textCols])}) AND ${scope.sql}
            ORDER BY rank, sc.raised_at DESC LIMIT ?`,
      args: [
        exact,
        exact,
        ...[...idCols, ...codeCols, ...textCols].map(() => prefix),
        ...[...idCols, ...codeCols, ...textCols].map(() => contains),
        ...scope.args,
        GROUP_LIMIT + 1,
      ],
    });
  } else {
    notPermitted.push('CASE');
  }

  // ---- Sales orders --------------------------------------------------------
  if (canViewSalesOrders(permissions)) {
    const scope = await scopedSalesOrders(db, userId);
    const idCols = ['so.sales_order_id'];
    const codeCols = ['so.document_number', 'so.invoice_number'];
    queries.push({
      group: 'SALES_ORDER',
      sql: `SELECT so.sales_order_id AS id, so.document_number AS title, so.account_id AS account_id,
              COALESCE(so.invoice_number, '') AS c1, a.account_name AS c2,
              so.status AS c3, af.affiliate_name AS c4,
              ${rankExpression(idCols, codeCols, [])} AS rank
            FROM sales_orders so
            JOIN accounts a ON a.account_id = so.account_id
            JOIN affiliates af ON af.affiliate_id = so.affiliate_id
            WHERE (${matchExpression([...idCols, ...codeCols])}) AND ${scope.sql}
            ORDER BY rank, so.order_created_at DESC LIMIT ?`,
      args: [
        exact,
        exact,
        exact,
        ...[...idCols, ...codeCols].map(() => prefix),
        ...[...idCols, ...codeCols].map(() => contains),
        ...scope.args,
        GROUP_LIMIT + 1,
      ],
    });
  } else {
    notPermitted.push('SALES_ORDER');
  }

  // ---- Purchase orders -----------------------------------------------------
  if (canViewPurchaseOrders(permissions)) {
    const scope = await scopedPurchaseOrders(db, userId);
    const idCols = ['po.purchase_order_id'];
    const codeCols = ['po.document_number'];
    const textCols = ['po.supplier_name'];
    queries.push({
      group: 'PURCHASE_ORDER',
      sql: `SELECT po.purchase_order_id AS id, po.document_number AS title, '' AS account_id,
              COALESCE(po.supplier_name, '') AS c1, af.affiliate_name AS c2,
              po.status AS c3, COALESCE(bu.business_unit_name, '') AS c4,
              ${rankExpression(idCols, codeCols, textCols)} AS rank
            FROM purchase_orders po
            JOIN affiliates af ON af.affiliate_id = po.affiliate_id
            LEFT JOIN business_units bu ON bu.business_unit_id = po.business_unit_id
            WHERE (${matchExpression([...idCols, ...codeCols, ...textCols])}) AND ${scope.sql}
            ORDER BY rank, po.po_created_at DESC LIMIT ?`,
      args: [
        exact,
        exact,
        ...[...idCols, ...codeCols, ...textCols].map(() => prefix),
        ...[...idCols, ...codeCols, ...textCols].map(() => contains),
        ...scope.args,
        GROUP_LIMIT + 1,
      ],
    });
  } else {
    notPermitted.push('PURCHASE_ORDER');
  }

  return { queries, notPermitted };
}

/** Where a hit goes. One place, so a group cannot link somewhere wrong. */
function hrefFor(group: SearchGroup, id: string, accountId: string): string {
  switch (group) {
    case 'ACCOUNT':
      return `/app/operations/customers/${id}`;
    case 'CONTACT':
      return `/app/operations/customers/${accountId}?tab=contacts`;
    case 'LEAD':
      return `/app/crm/${id}`;
    case 'OPPORTUNITY':
      return `/app/crm/opportunities/${id}`;
    case 'CASE':
      return `/app/helpdesk/${id}`;
    case 'SALES_ORDER':
      return `/app/orders/sales/${id}`;
    case 'PURCHASE_ORDER':
      return `/app/orders/purchases/${id}`;
  }
}

/**
 * The context line under each hit.
 *
 * Each group's query selects its own four context columns, chosen so that a
 * customer reads like a customer and an order reads like an order, which is
 * why this function is uniform and the SELECTs are not. Empty parts are
 * dropped rather than rendered as a run of separators.
 */
function contextFor(row: Record<string, unknown>): string {
  const parts = [text(row.c1), text(row.c2), text(row.c3), text(row.c4)].filter((p) => p !== '');
  return parts.join(' · ');
}

export async function globalSearch(
  db: Client,
  userId: string,
  permissions: readonly string[],
  rawQuery: string,
): Promise<SearchResult> {
  const query = rawQuery.trim().slice(0, 120);
  if (query.length < MIN_QUERY_LENGTH) {
    return { query, groups: [], total: 0, notPermitted: [] };
  }

  const { queries, notPermitted } = await buildQueries(db, userId, permissions, query);
  const executed = await Promise.all(
    queries.map(async (q) => ({
      group: q.group,
      rows: (await db.execute({ sql: q.sql, args: q.args as never[] })).rows,
    })),
  );

  const groups: SearchGroupResult[] = [];
  let total = 0;
  for (const { group, rows } of executed) {
    if (rows.length === 0) continue;
    const more = rows.length > GROUP_LIMIT;
    const hits = rows.slice(0, GROUP_LIMIT).map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      const id = text(row.id);
      return {
        group,
        id,
        title: text(row.title),
        context: contextFor(row),
        // A contact's link needs its account, which is in the context row.
        href: hrefFor(group, id, text(row.account_id)),
        rank: Number(row.rank ?? 3),
      };
    });
    total += hits.length;
    groups.push({ group, label: GROUP_LABEL[group], hits, more });
  }

  // Groups are ordered by their best hit, so typing a document number puts
  // Sales orders first and not Customers, whatever the fixed group order is.
  groups.sort((a, b) => {
    const best = (g: SearchGroupResult) => Math.min(...g.hits.map((h) => h.rank));
    return best(a) - best(b) || a.label.localeCompare(b.label);
  });

  return { query, groups, total, notPermitted };
}
