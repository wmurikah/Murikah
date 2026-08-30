/**
 * The audit workspace: reading the trail, not writing it.
 *
 * NOTHING IN THIS MODULE WRITES AN AUDIT ROW except the export, which audits
 * itself. There is no update and no delete, here or anywhere: the database
 * refuses both through the triggers in
 * docs/cms/audit/08_audit_immutability.sql, and this module would fail
 * loudly if it tried.
 *
 * THE SCOPE PROBLEM, AND HOW IT IS SOLVED.
 * `audit_events.entity_id` has no foreign key, because the trail is
 * polymorphic like the rest of the system. So an audit row carries no
 * country, no affiliate and no owner, and deciding whether a local
 * administrator may read it means resolving the entity it names first.
 *
 * This is done with one correlated EXISTS per resolvable entity type, each
 * calling that module's OWN canonical scope helper. `scopedAccounts`,
 * `scopedLeads`, `scopedOpportunities`, `scopedCases`, `scopedSalesOrders`
 * and `scopedPurchaseOrders` are imported and used, never re-implemented, so
 * an audit row about a sales order is visible to exactly the people who can
 * see that sales order. When phase 07's scope rules change, this changes with
 * them and cannot drift.
 *
 * AN UNRESOLVABLE ROW IS VISIBLE TO A GROUP PRINCIPAL ONLY. That covers two
 * cases and they are treated identically on purpose:
 *
 *   - An entity type with no scope of its own: a role, a workflow, an SLA
 *     rule, a permission grant. These are Group configuration, and section 8
 *     is explicit that Group security configuration must not leak to a local
 *     administrator.
 *   - An entity that no longer exists. A deleted or renamed record cannot be
 *     resolved, and the safe reading of "I cannot tell whose this was" is to
 *     withhold it rather than to show it. The alternative fails open, and an
 *     attacker who could delete a record would gain the audit rows about it.
 *
 * Every principal additionally sees their own actions and their own user
 * record's events, whatever their scope. A person may always read what they
 * themselves did.
 */
import type { Client } from '@libsql/client/web';
import { resolveScope } from '../auth/rbac.ts';
import { AUDIT_VIEW, AUDIT_SECURITY_VIEW } from '../permissions.ts';
import { scopedAccounts } from './accountAdmin.ts';
import { scopedLeads } from './leadAdmin.ts';
import { scopedOpportunities } from './opportunityAdmin.ts';
import { scopedCases } from './serviceAdmin.ts';
import { scopedSalesOrders } from './soPerformance.ts';
import { scopedPurchaseOrders } from './poPerformance.ts';
import {
  AUDIT_CATALOGUE,
  describe,
  classify,
  type AuditClass,
  SECURITY_EVENT_TYPES,
} from '../audit/catalogue.ts';
import { diffPayloads, summariseDiff, type DiffResult } from '../audit/diff.ts';
import { maskedJson } from '../audit/mask.ts';
import { toDbTimestamp } from '../auth/session.ts';
import { auditEventStmt, type Stmt } from './authRecords.ts';
import { csvCell } from './soPerformance.ts';

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

/**
 * The default window, stated here because section 12 requires it stated.
 *
 * THIRTY DAYS, and a hard page size of 50. `audit_events` becomes the largest
 * table in the database: one order import writes rows for hundreds of
 * documents, and the SLA engine and the notification writer add more every
 * hour. An unbounded default would eventually mean a query that scans years
 * to render a screen nobody reads past the first page of.
 *
 * The window is a default, not a ceiling. A reader investigating something
 * from March sets the dates and gets March, and the query is still bounded
 * because it is still a range.
 */
export const DEFAULT_WINDOW_DAYS = 30;
export const PAGE_SIZE = 50;
/** A reader can widen the window, but not to unbounded. */
export const MAX_WINDOW_DAYS = 366;
/** The ceiling on one export. Beyond this the reader narrows their filter. */
export const MAX_EXPORT_ROWS = 10000;

export interface AuditFilter {
  from: string;
  to: string;
  /** Free text over actor name, actor email and entity id. */
  search: string;
  actorUserId: string | null;
  entityType: string | null;
  eventType: string | null;
  action: string | null;
  classification: AuditClass | null;
  /** Only events the catalogue marks high-impact. */
  highRiskOnly: boolean;
  countryId: string | null;
  affiliateId: string | null;
  page: number;
}

function isoDate(date: Date): string {
  return toDbTimestamp(date).slice(0, 10);
}

/** A date parameter that is not a date is the default, never a silent today. */
function readDate(raw: string | null, fallback: string): string {
  if (raw === null) return fallback;
  const trimmed = raw.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : fallback;
}

export function parseAuditFilter(params: URLSearchParams, now: Date): AuditFilter {
  const to = new Date(now);
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - DEFAULT_WINDOW_DAYS);

  let fromDate = readDate(params.get('from'), isoDate(from));
  let toDate = readDate(params.get('to'), isoDate(to));
  // A reversed range is corrected rather than returned empty, the same rule
  // the analytics filter follows, so a mistyped date does not read as "no
  // audit rows exist", which is the most alarming possible wrong answer.
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];

  const pageRaw = params.get('page');
  const page = pageRaw === null || !/^\d+$/.test(pageRaw) ? 1 : Math.max(1, Number(pageRaw));

  const classRaw = params.get('classification');
  const classification =
    classRaw === 'SECURITY' || classRaw === 'CONFIGURATION' || classRaw === 'BUSINESS'
      ? classRaw
      : null;

  const empty = (value: string | null): string | null =>
    value === null || value.trim() === '' ? null : value.trim();

  return {
    from: fromDate,
    to: toDate,
    search: (params.get('q') ?? '').trim().slice(0, 120),
    actorUserId: empty(params.get('actorUserId')),
    entityType: empty(params.get('entityType')),
    eventType: empty(params.get('eventType')),
    action: empty(params.get('action')),
    classification,
    highRiskOnly: params.get('highRisk') === '1',
    countryId: empty(params.get('countryId')),
    affiliateId: empty(params.get('affiliateId')),
    page,
  };
}

/** The filter back to a query string, so a view is shareable. */
export function auditFilterToQuery(filter: AuditFilter): string {
  const params = new URLSearchParams();
  params.set('from', filter.from);
  params.set('to', filter.to);
  if (filter.search !== '') params.set('q', filter.search);
  if (filter.actorUserId !== null) params.set('actorUserId', filter.actorUserId);
  if (filter.entityType !== null) params.set('entityType', filter.entityType);
  if (filter.eventType !== null) params.set('eventType', filter.eventType);
  if (filter.action !== null) params.set('action', filter.action);
  if (filter.classification !== null) params.set('classification', filter.classification);
  if (filter.highRiskOnly) params.set('highRisk', '1');
  if (filter.countryId !== null) params.set('countryId', filter.countryId);
  if (filter.affiliateId !== null) params.set('affiliateId', filter.affiliateId);
  if (filter.page > 1) params.set('page', String(filter.page));
  return params.toString();
}

export interface AuditScope {
  readonly sql: string;
  readonly args: unknown[];
  /** True where the principal reads everything. Reported in the interface. */
  readonly group: boolean;
  readonly granted: boolean;
}

const DENY = '1 = 0';

/**
 * The audit read predicate for one principal, over the alias `ae`.
 *
 * Six EXISTS subqueries, each delegating to the module that owns the entity.
 * The subqueries are correlated on `ae.entity_type` first, so SQLite can
 * discard five of them per row on a cheap string comparison before it touches
 * another table.
 */
export async function auditScope(db: Client, userId: string): Promise<AuditScope> {
  const resolution = await resolveScope(db, userId, AUDIT_VIEW);
  if (!resolution.granted) return { sql: DENY, args: [], group: false, granted: false };
  if (resolution.group) return { sql: '1 = 1', args: [], group: true, granted: true };

  const [accounts, leads, opportunities, cases, salesOrders, purchaseOrders] = await Promise.all([
    scopedAccounts(db, userId),
    scopedLeads(db, userId),
    scopedOpportunities(db, userId),
    scopedCases(db, userId),
    scopedSalesOrders(db, userId),
    scopedPurchaseOrders(db, userId),
  ]);

  const branches: string[] = [
    // Always: their own actions, and their own user record.
    `ae.actor_user_id = ?`,
    `(ae.entity_type = 'USER' AND ae.entity_id = ?)`,
    // ACCOUNT and CONTACT both resolve through the account.
    `(ae.entity_type = 'ACCOUNT' AND EXISTS (
        SELECT 1 FROM accounts a WHERE a.account_id = ae.entity_id AND ${accounts.sql}))`,
    `(ae.entity_type = 'CONTACT' AND EXISTS (
        SELECT 1 FROM contacts c JOIN accounts a ON a.account_id = c.account_id
         WHERE c.contact_id = ae.entity_id AND ${accounts.sql}))`,
    `(ae.entity_type = 'LEAD' AND EXISTS (
        SELECT 1 FROM leads l LEFT JOIN accounts a ON a.account_id = l.account_id
         WHERE l.lead_id = ae.entity_id AND ${leads.sql}))`,
    `(ae.entity_type = 'OPPORTUNITY' AND EXISTS (
        SELECT 1 FROM opportunities o JOIN accounts a ON a.account_id = o.account_id
         WHERE o.opportunity_id = ae.entity_id AND ${opportunities.sql}))`,
    `(ae.entity_type IN ('CASE','SERVICE_CASE') AND EXISTS (
        SELECT 1 FROM service_cases sc JOIN accounts a ON a.account_id = sc.account_id
         WHERE sc.case_id = ae.entity_id AND ${cases.sql}))`,
    `(ae.entity_type = 'SALES_ORDER' AND EXISTS (
        SELECT 1 FROM sales_orders so JOIN affiliates af ON af.affiliate_id = so.affiliate_id
         WHERE so.sales_order_id = ae.entity_id AND ${salesOrders.sql}))`,
    `(ae.entity_type = 'PURCHASE_ORDER' AND EXISTS (
        SELECT 1 FROM purchase_orders po JOIN affiliates af ON af.affiliate_id = po.affiliate_id
         WHERE po.purchase_order_id = ae.entity_id AND ${purchaseOrders.sql}))`,
  ];

  const args: unknown[] = [
    userId,
    userId,
    ...accounts.args,
    ...accounts.args,
    ...leads.args,
    ...opportunities.args,
    ...cases.args,
    ...salesOrders.args,
    ...purchaseOrders.args,
  ];

  return { sql: `(${branches.join(' OR ')})`, args, group: false, granted: true };
}

/**
 * Whether this principal may read security events at all.
 *
 * Separate from the audit scope because it is a different question. A finance
 * manager holds AUDIT.EVENTS.VIEW so they can see what happened to an order;
 * that is not a reason to read sign-in failures and role grants.
 *
 * The permission does not exist until the operator runs
 * docs/cms/audit/09_add_audit_permissions.sql, so this correctly returns
 * false for everybody, including the system administrator, until then. The
 * interface says so by name.
 */
export async function maySeeSecurityEvents(db: Client, userId: string): Promise<boolean> {
  const resolution = await resolveScope(db, userId, AUDIT_SECURITY_VIEW);
  return resolution.granted;
}

export interface AuditRow {
  auditEventId: string;
  eventAt: string;
  actorUserId: string | null;
  actorName: string;
  actorEmail: string | null;
  eventType: string;
  eventLabel: string;
  classification: AuditClass;
  highRisk: boolean;
  /** Why it is high-impact. Null on an ordinary event. */
  highRiskReason: string | null;
  entityType: string;
  entityId: string;
  action: string;
  /** The record in words where it could be resolved, else the identifier. */
  entityLabel: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** A short summary of the fields that changed, for the list. */
  changeSummary: string;
}

export interface AuditPage {
  items: AuditRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Stated on the page, so a reader knows what they are and are not seeing. */
  window: { from: string; to: string };
  /** False where the principal may not read security events. */
  securityIncluded: boolean;
}

/**
 * The filter clauses shared by the list, the count and the export, built once
 * so the three cannot disagree about what "the current view" means.
 */
function filterClauses(
  filter: AuditFilter,
  securityIncluded: boolean,
): { sql: string; args: unknown[] } {
  const clauses: string[] = ['ae.event_at >= ?', 'ae.event_at <= ?'];
  const args: unknown[] = [`${filter.from} 00:00:00`, `${filter.to} 23:59:59`];

  // The security gate is a clause, not a post-filter. A principal without the
  // code never has a security row in their result set, so there is nothing to
  // leak through a count, a total or an export.
  if (!securityIncluded && SECURITY_EVENT_TYPES.length > 0) {
    clauses.push(`ae.event_type NOT IN (${SECURITY_EVENT_TYPES.map(() => '?').join(', ')})`);
    args.push(...SECURITY_EVENT_TYPES);
  }

  if (filter.actorUserId !== null) {
    clauses.push('ae.actor_user_id = ?');
    args.push(filter.actorUserId);
  }
  if (filter.entityType !== null) {
    clauses.push('ae.entity_type = ?');
    args.push(filter.entityType);
  }
  if (filter.eventType !== null) {
    clauses.push('ae.event_type = ?');
    args.push(filter.eventType);
  }
  if (filter.action !== null) {
    clauses.push('ae.action = ?');
    args.push(filter.action);
  }
  if (filter.search !== '') {
    clauses.push(
      `(ae.entity_id = ? OR u.display_name LIKE ? OR u.email LIKE ? OR ae.event_type LIKE ?)`,
    );
    const like = `%${filter.search}%`;
    args.push(filter.search, like, like, like.toUpperCase());
  }
  return { sql: clauses.join(' AND '), args };
}

/**
 * Classification and high-risk are catalogue facts held in TypeScript, not
 * columns on the table, so they filter as an IN list of event types built
 * from the catalogue at query time. One definition, in catalogue.ts, rather
 * than a duplicate encoded as a CASE expression in SQL that would drift the
 * first time somebody added an event.
 *
 * A filter that matches no catalogued type yields `1 = 0` rather than no
 * clause at all. Dropping the clause would silently widen the query to
 * everything, which is the wrong way for a filter to fail.
 */
function catalogueClause(filter: AuditFilter): { sql: string; args: unknown[] } {
  if (filter.classification === null && !filter.highRiskOnly) return { sql: '', args: [] };
  const types = Object.entries(AUDIT_CATALOGUE)
    .filter(([, meta]) => {
      if (filter.classification !== null && meta.classification !== filter.classification) {
        return false;
      }
      return !(filter.highRiskOnly && !meta.highRisk);
    })
    .map(([code]) => code);
  if (types.length === 0) return { sql: ' AND 1 = 0', args: [] };
  return { sql: ` AND ae.event_type IN (${types.map(() => '?').join(', ')})`, args: types };
}

function toRow(raw: unknown): AuditRow {
  const row = raw as Record<string, unknown>;
  const eventType = text(row.event_type);
  const meta = describe(eventType);
  const diff = diffPayloads(nullableText(row.before_json), nullableText(row.after_json));
  return {
    auditEventId: text(row.audit_event_id),
    eventAt: text(row.event_at),
    actorUserId: nullableText(row.actor_user_id),
    // A null actor is a system action or a removed user. Both are readable
    // facts and neither is "unknown user", which sounds like a defect.
    actorName: row.actor_user_id === null ? 'System' : text(row.display_name),
    actorEmail: nullableText(row.email),
    eventType,
    eventLabel: meta.label,
    classification: meta.classification,
    highRisk: meta.highRisk,
    highRiskReason: meta.why ?? null,
    entityType: text(row.entity_type),
    entityId: text(row.entity_id),
    action: text(row.action),
    entityLabel: nullableText(row.entity_label),
    ipAddress: nullableText(row.ip_address),
    userAgent: nullableText(row.user_agent),
    changeSummary: summariseDiff(diff),
  };
}

/**
 * The entity's own name, resolved in the same query rather than one lookup
 * per row. Six correlated scalar subqueries, each guarded by the entity type
 * so only one runs per row, which is what keeps this from being an N+1.
 */
const ENTITY_LABEL = `CASE ae.entity_type
    WHEN 'ACCOUNT' THEN (SELECT a2.account_name FROM accounts a2 WHERE a2.account_id = ae.entity_id)
    WHEN 'CONTACT' THEN (SELECT c2.full_name FROM contacts c2 WHERE c2.contact_id = ae.entity_id)
    WHEN 'LEAD' THEN (SELECT l2.title FROM leads l2 WHERE l2.lead_id = ae.entity_id)
    WHEN 'OPPORTUNITY' THEN (SELECT o2.title FROM opportunities o2 WHERE o2.opportunity_id = ae.entity_id)
    WHEN 'CASE' THEN (SELECT s2.case_number FROM service_cases s2 WHERE s2.case_id = ae.entity_id)
    WHEN 'SALES_ORDER' THEN (SELECT so2.document_number FROM sales_orders so2 WHERE so2.sales_order_id = ae.entity_id)
    WHEN 'PURCHASE_ORDER' THEN (SELECT po2.document_number FROM purchase_orders po2 WHERE po2.purchase_order_id = ae.entity_id)
    WHEN 'USER' THEN (SELECT u2.display_name FROM users u2 WHERE u2.user_id = ae.entity_id)
    WHEN 'ACCESS_ROLE' THEN (SELECT r2.role_name FROM access_roles r2 WHERE r2.role_id = ae.entity_id)
    ELSE NULL END`;

export async function listAuditEvents(
  db: Client,
  userId: string,
  filter: AuditFilter,
): Promise<AuditPage> {
  const scope = await auditScope(db, userId);
  const securityIncluded = await maySeeSecurityEvents(db, userId);
  const empty: AuditPage = {
    items: [],
    total: 0,
    page: filter.page,
    pageSize: PAGE_SIZE,
    window: { from: filter.from, to: filter.to },
    securityIncluded,
  };
  if (!scope.granted) return empty;

  const base = filterClauses(filter, securityIncluded);
  const cat = catalogueClause(filter);
  const where = `${base.sql}${cat.sql} AND ${scope.sql}`;
  const args = [...base.args, ...cat.args, ...scope.args];

  const counted = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM audit_events ae
          LEFT JOIN users u ON u.user_id = ae.actor_user_id
          WHERE ${where}`,
    args: args as never[],
  });
  const total = Number((counted.rows[0] as unknown as Record<string, unknown>).n ?? 0);

  const offset = (filter.page - 1) * PAGE_SIZE;
  const result = await db.execute({
    sql: `SELECT ae.audit_event_id, ae.actor_user_id, ae.event_type, ae.entity_type,
            ae.entity_id, ae.action, ae.before_json, ae.after_json, ae.ip_address,
            ae.user_agent, ae.event_at, u.display_name, u.email,
            ${ENTITY_LABEL} AS entity_label
          FROM audit_events ae
          LEFT JOIN users u ON u.user_id = ae.actor_user_id
          WHERE ${where}
          ORDER BY ae.event_at DESC, ae.audit_event_id DESC
          LIMIT ? OFFSET ?`,
    args: [...args, PAGE_SIZE, offset] as never[],
  });

  return { ...empty, items: result.rows.map(toRow), total };
}

export interface AuditDetail extends AuditRow {
  diff: DiffResult;
  /** Masked, and only rendered behind the Technical Details disclosure. */
  beforeJson: string | null;
  afterJson: string | null;
}

/**
 * One event, or null.
 *
 * The scope predicate is applied here as well as in the list. An identifier
 * lifted from somebody else's screen is not authorisation, and a detail
 * endpoint that trusted the list to have filtered would be the hole.
 */
export async function auditEvent(
  db: Client,
  userId: string,
  auditEventId: string,
): Promise<AuditDetail | null> {
  const scope = await auditScope(db, userId);
  if (!scope.granted) return null;
  const securityIncluded = await maySeeSecurityEvents(db, userId);

  const clauses: string[] = ['ae.audit_event_id = ?', scope.sql];
  const args: unknown[] = [auditEventId, ...scope.args];
  if (!securityIncluded && SECURITY_EVENT_TYPES.length > 0) {
    clauses.splice(
      1,
      0,
      `ae.event_type NOT IN (${SECURITY_EVENT_TYPES.map(() => '?').join(', ')})`,
    );
    args.splice(1, 0, ...SECURITY_EVENT_TYPES);
  }

  const result = await db.execute({
    sql: `SELECT ae.audit_event_id, ae.actor_user_id, ae.event_type, ae.entity_type,
            ae.entity_id, ae.action, ae.before_json, ae.after_json, ae.ip_address,
            ae.user_agent, ae.event_at, u.display_name, u.email,
            ${ENTITY_LABEL} AS entity_label
          FROM audit_events ae
          LEFT JOIN users u ON u.user_id = ae.actor_user_id
          WHERE ${clauses.join(' AND ')} LIMIT 1`,
    args: args as never[],
  });
  const raw = result.rows[0];
  if (raw === undefined) return null;

  const row = raw as unknown as Record<string, unknown>;
  return {
    ...toRow(raw),
    diff: diffPayloads(nullableText(row.before_json), nullableText(row.after_json)),
    beforeJson: maskedJson(nullableText(row.before_json)),
    afterJson: maskedJson(nullableText(row.after_json)),
  };
}

/**
 * Every event about one entity, for the View Audit History action.
 *
 * The caller has already established that the principal may see the entity;
 * the audit scope is applied again anyway, because "may see the customer" and
 * "may read the audit trail" are two permissions and holding one is not
 * holding the other.
 */
export async function entityHistory(
  db: Client,
  userId: string,
  entityType: string,
  entityId: string,
  limit = 100,
): Promise<AuditRow[]> {
  const scope = await auditScope(db, userId);
  if (!scope.granted) return [];
  const securityIncluded = await maySeeSecurityEvents(db, userId);

  const clauses = ['ae.entity_type = ?', 'ae.entity_id = ?', scope.sql];
  const args: unknown[] = [entityType, entityId, ...scope.args];
  if (!securityIncluded && SECURITY_EVENT_TYPES.length > 0) {
    clauses.splice(
      2,
      0,
      `ae.event_type NOT IN (${SECURITY_EVENT_TYPES.map(() => '?').join(', ')})`,
    );
    args.splice(2, 0, ...SECURITY_EVENT_TYPES);
  }

  const result = await db.execute({
    sql: `SELECT ae.audit_event_id, ae.actor_user_id, ae.event_type, ae.entity_type,
            ae.entity_id, ae.action, ae.before_json, ae.after_json, ae.ip_address,
            ae.user_agent, ae.event_at, u.display_name, u.email,
            ${ENTITY_LABEL} AS entity_label
          FROM audit_events ae
          LEFT JOIN users u ON u.user_id = ae.actor_user_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY ae.event_at DESC, ae.audit_event_id DESC LIMIT ?`,
    args: [...args, limit] as never[],
  });
  return result.rows.map(toRow);
}

/**
 * What one user CHANGED. Deliberately not what they signed in to.
 *
 * Section 5 is explicit: this is not login history. Authentication events
 * belong in the security view, behind its own permission, because a list of
 * somebody's sign-in times on their profile page is surveillance wearing an
 * audit badge, and it is also the wrong place to investigate a compromise.
 */
export async function userActivity(
  db: Client,
  userId: string,
  subjectUserId: string,
  limit = 100,
): Promise<AuditRow[]> {
  const scope = await auditScope(db, userId);
  if (!scope.granted) return [];

  const types = SECURITY_EVENT_TYPES.filter((code) => classify(code) === 'SECURITY');
  const result = await db.execute({
    sql: `SELECT ae.audit_event_id, ae.actor_user_id, ae.event_type, ae.entity_type,
            ae.entity_id, ae.action, ae.before_json, ae.after_json, ae.ip_address,
            ae.user_agent, ae.event_at, u.display_name, u.email,
            ${ENTITY_LABEL} AS entity_label
          FROM audit_events ae
          LEFT JOIN users u ON u.user_id = ae.actor_user_id
          WHERE ae.actor_user_id = ?
            AND ae.event_type NOT IN (${types.map(() => '?').join(', ')})
            AND ${scope.sql}
          ORDER BY ae.event_at DESC, ae.audit_event_id DESC LIMIT ?`,
    args: [subjectUserId, ...types, ...scope.args, limit] as never[],
  });
  return result.rows.map(toRow);
}

/**
 * The security view: authentication and access events.
 *
 * Gated on AUDIT.EVENTS.SECURITY_VIEW, which does not exist until the
 * operator runs the data script, so this correctly returns nothing for
 * everybody until then.
 *
 * THE FAILURE REASON IS NOT IN THIS SHAPE AT ALL. Section 5 requires that a
 * detailed sign-in failure reason is not exposed to an unauthorised
 * principal, and the way to guarantee that is for the unauthorised path to
 * return no rows rather than rows with a field blanked. A blanked field is
 * one refactor away from being un-blanked.
 */
export async function securityEvents(
  db: Client,
  userId: string,
  filter: AuditFilter,
): Promise<AuditPage> {
  const allowed = await maySeeSecurityEvents(db, userId);
  const scope = await auditScope(db, userId);
  const empty: AuditPage = {
    items: [],
    total: 0,
    page: filter.page,
    pageSize: PAGE_SIZE,
    window: { from: filter.from, to: filter.to },
    securityIncluded: allowed,
  };
  if (!allowed || !scope.granted) return empty;

  const clauses = [
    'ae.event_at >= ?',
    'ae.event_at <= ?',
    `ae.event_type IN (${SECURITY_EVENT_TYPES.map(() => '?').join(', ')})`,
    scope.sql,
  ];
  const args: unknown[] = [
    `${filter.from} 00:00:00`,
    `${filter.to} 23:59:59`,
    ...SECURITY_EVENT_TYPES,
    ...scope.args,
  ];
  if (filter.actorUserId !== null) {
    clauses.push('ae.actor_user_id = ?');
    args.push(filter.actorUserId);
  }
  if (filter.eventType !== null) {
    clauses.push('ae.event_type = ?');
    args.push(filter.eventType);
  }

  const where = clauses.join(' AND ');
  const counted = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM audit_events ae
          LEFT JOIN users u ON u.user_id = ae.actor_user_id WHERE ${where}`,
    args: args as never[],
  });
  const result = await db.execute({
    sql: `SELECT ae.audit_event_id, ae.actor_user_id, ae.event_type, ae.entity_type,
            ae.entity_id, ae.action, ae.before_json, ae.after_json, ae.ip_address,
            ae.user_agent, ae.event_at, u.display_name, u.email,
            ${ENTITY_LABEL} AS entity_label
          FROM audit_events ae
          LEFT JOIN users u ON u.user_id = ae.actor_user_id
          WHERE ${where}
          ORDER BY ae.event_at DESC, ae.audit_event_id DESC LIMIT ? OFFSET ?`,
    args: [...args, PAGE_SIZE, (filter.page - 1) * PAGE_SIZE] as never[],
  });

  return {
    ...empty,
    items: result.rows.map(toRow),
    total: Number((counted.rows[0] as unknown as Record<string, unknown>).n ?? 0),
  };
}

/** Distinct values for the filter's option lists, inside the reader's scope. */
export async function auditFilterOptions(
  db: Client,
  userId: string,
): Promise<{
  actors: { userId: string; label: string }[];
  entityTypes: string[];
  actions: string[];
}> {
  const scope = await auditScope(db, userId);
  if (!scope.granted) return { actors: [], entityTypes: [], actions: [] };

  const [actors, types] = await Promise.all([
    db.execute({
      sql: `SELECT DISTINCT ae.actor_user_id AS id, u.display_name AS label
            FROM audit_events ae JOIN users u ON u.user_id = ae.actor_user_id
            WHERE ${scope.sql} ORDER BY u.display_name LIMIT 200`,
      args: scope.args as never[],
    }),
    db.execute({
      sql: `SELECT DISTINCT ae.entity_type AS entity_type, ae.action AS action
            FROM audit_events ae WHERE ${scope.sql} ORDER BY ae.entity_type, ae.action`,
      args: scope.args as never[],
    }),
  ]);

  const entityTypes = new Set<string>();
  const actions = new Set<string>();
  for (const raw of types.rows) {
    const row = raw as unknown as Record<string, unknown>;
    entityTypes.add(text(row.entity_type));
    actions.add(text(row.action));
  }
  return {
    actors: actors.rows.map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      return { userId: text(row.id), label: text(row.label) };
    }),
    entityTypes: [...entityTypes].sort(),
    actions: [...actions].sort(),
  };
}

// ---- Export -------------------------------------------------------------------

/**
 * The export writes its own audit row, which is the point of it.
 *
 * `AUDIT_EXPORTED` records the filters and the row count and NOT the data.
 * Storing the exported dataset inside an audit row would double the size of
 * the table with every export, and would put the very content the export
 * controls exist to protect inside the table those controls guard.
 */
export const AUDIT_EXPORT_EVENT = 'AUDIT_EXPORTED';

export interface AuditExportResult {
  csv: string;
  rowCount: number;
  /** True where the filter matched more than the ceiling and was cut. */
  truncated: boolean;
  totalMatching: number;
}

/**
 * Filtered audit evidence as CSV.
 *
 * SAME FILTERS, SAME SCOPE. The rows come from `listAuditEvents` clauses
 * rebuilt identically, not from a separate query with its own idea of the
 * population, so a user cannot gain a single row by exporting rather than
 * reading. The security gate applies here too: a principal without
 * SECURITY_VIEW exports no security event, because the clause that removes
 * them is in the shared filter builder.
 *
 * A before-and-after SUMMARY, not the payloads. The masked field-level
 * summary says which fields changed, which is what evidence needs; shipping
 * the raw JSON would ship whatever a historical row happens to contain.
 */
export async function exportAuditCsv(
  db: Client,
  userId: string,
  filter: AuditFilter,
  generatedAt: string,
  generatedBy: string,
): Promise<AuditExportResult> {
  const scope = await auditScope(db, userId);
  if (!scope.granted) return { csv: '', rowCount: 0, truncated: false, totalMatching: 0 };
  const securityIncluded = await maySeeSecurityEvents(db, userId);

  const base = filterClauses(filter, securityIncluded);
  const cat = catalogueClause(filter);
  const where = `${base.sql}${cat.sql} AND ${scope.sql}`;
  const args = [...base.args, ...cat.args, ...scope.args];

  const counted = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM audit_events ae
          LEFT JOIN users u ON u.user_id = ae.actor_user_id WHERE ${where}`,
    args: args as never[],
  });
  const totalMatching = Number((counted.rows[0] as unknown as Record<string, unknown>).n ?? 0);

  const result = await db.execute({
    sql: `SELECT ae.audit_event_id, ae.actor_user_id, ae.event_type, ae.entity_type,
            ae.entity_id, ae.action, ae.before_json, ae.after_json, ae.ip_address,
            ae.user_agent, ae.event_at, u.display_name, u.email,
            ${ENTITY_LABEL} AS entity_label
          FROM audit_events ae
          LEFT JOIN users u ON u.user_id = ae.actor_user_id
          WHERE ${where}
          ORDER BY ae.event_at DESC, ae.audit_event_id DESC LIMIT ?`,
    args: [...args, MAX_EXPORT_ROWS] as never[],
  });
  const rows = result.rows.map(toRow);

  const header = [
    'Timestamp (UTC)',
    'Actor',
    'Actor email',
    'Event',
    'Event code',
    'Classification',
    'High impact',
    'Entity type',
    'Record',
    'Entity id',
    'Action',
    'What changed',
  ];
  const lines = [
    `# Audit evidence export`,
    `# Generated at,${csvCell(generatedAt)}`,
    `# Generated by,${csvCell(generatedBy)}`,
    `# Date range,${csvCell(`${filter.from} to ${filter.to}`)}`,
    `# Filters,${csvCell(describeFilter(filter))}`,
    `# Security events included,${csvCell(securityIncluded ? 'Yes' : 'No, not permitted')}`,
    `# Rows,${csvCell(String(rows.length))}`,
    `# Matching rows,${csvCell(String(totalMatching))}`,
    ...(rows.length < totalMatching
      ? [`# Truncated,${csvCell(`Capped at ${MAX_EXPORT_ROWS}. Narrow the filter for the rest.`)}`]
      : []),
    '',
    header.map(csvCell).join(','),
    ...rows.map((row) =>
      [
        row.eventAt,
        row.actorName,
        row.actorEmail ?? 'Not available',
        row.eventLabel,
        row.eventType,
        row.classification,
        row.highRisk ? 'Yes' : 'No',
        row.entityType,
        row.entityLabel ?? 'Not available',
        row.entityId,
        row.action,
        row.changeSummary,
      ]
        .map(csvCell)
        .join(','),
    ),
  ];

  return {
    csv: lines.join('\n'),
    rowCount: rows.length,
    truncated: rows.length < totalMatching,
    totalMatching,
  };
}

/** The filter in one readable line, for the file header and the audit row. */
export function describeFilter(filter: AuditFilter): string {
  const parts: string[] = [`${filter.from} to ${filter.to}`];
  if (filter.search !== '') parts.push(`search "${filter.search}"`);
  if (filter.actorUserId !== null) parts.push(`actor ${filter.actorUserId}`);
  if (filter.entityType !== null) parts.push(`entity type ${filter.entityType}`);
  if (filter.eventType !== null) parts.push(`event ${filter.eventType}`);
  if (filter.action !== null) parts.push(`action ${filter.action}`);
  if (filter.classification !== null) parts.push(`class ${filter.classification}`);
  if (filter.highRiskOnly) parts.push('high impact only');
  return parts.join('; ');
}

/**
 * The audit row for an export. Filters and count, never content.
 *
 * `entity_type` is AUDIT_EXPORT and `entity_id` is the generation timestamp,
 * because an export names no single record and inventing one would make the
 * row lie about what it describes.
 */
export function auditExportStmt(input: {
  actorUserId: string;
  filter: AuditFilter;
  rowCount: number;
  totalMatching: number;
  format: string;
  ip: string | null;
  userAgent: string | null;
  now: Date;
}): Stmt {
  return auditEventStmt({
    actorUserId: input.actorUserId,
    eventType: AUDIT_EXPORT_EVENT,
    entityType: 'AUDIT_EXPORT',
    entityId: toDbTimestamp(input.now),
    action: 'EXPORT',
    beforeJson: null,
    afterJson: JSON.stringify({
      filters: describeFilter(input.filter),
      rowCount: input.rowCount,
      matchingRows: input.totalMatching,
      format: input.format,
    }),
    ip: input.ip,
    userAgent: input.userAgent,
    now: input.now,
  }) as Stmt;
}
