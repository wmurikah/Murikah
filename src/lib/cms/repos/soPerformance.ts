/**
 * Sales order operations and performance.
 *
 * ONE SCOPE PREDICATE, USED BY EVERY QUERY ON THIS PAGE.
 * `soPopulation` below builds the FROM and the WHERE that the operations
 * list, every KPI, every chart and the export all use. A count that includes
 * an order the reader cannot open is a leak, and the only way to be certain
 * the count and the list agree is for them to be the same predicate. The
 * predicate itself comes from the Build Prompt 07 resolver, which is called
 * and never re-implemented.
 *
 * EVERY AGGREGATE IS SQL.
 * Median and P90 come from window functions in ../analytics/stats.ts with
 * the definitions stated there. Nothing fetches rows to reduce them in a
 * loop.
 *
 * NOTHING IS INVENTED, AND NULL IS NEVER ZERO.
 * The real extract carries no currency, no order value and no load
 * timestamp. Those columns are NULL on nearly every row, so every figure
 * derived from them reports its coverage and renders "Not available" where
 * it has nothing. A blank credit column set means credit was NOT REQUIRED,
 * which is a different fact from credit taking no time, and the two are
 * never merged.
 *
 * THE SOURCE VARIANCE COLUMNS ARE NOT HERE.
 * FINANCE_VARIANCE, CREDIT_VARIANCE, INVOICE_VARIANCE,
 * LOADING_AUTHORITY_VARIANCE and DELAYED_RAISING_ORDERS live in the import
 * payload and are shown on the Source History tab as reconciliation
 * evidence. No figure on any dashboard is computed from them; every duration
 * here is arithmetic on timestamps.
 */
import type { Client } from '@libsql/client/web';
import { resolveScope, scopePredicate, DENY_ALL, type Predicate } from '../auth/rbac.ts';
import { SALES_ORDER_VIEW } from '../permissions.ts';
import {
  andAll,
  bucketExpression,
  dateWindow,
  equals,
  type AnalyticsFilter,
  type SqlFragment,
} from '../analytics/filters.ts';
import { durationStats, minutesBetweenSql, rate, type DurationStats } from '../analytics/stats.ts';

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const number = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * The sales order scope, canonical here.
 *
 * The alias contract is fixed: `so` for sales_orders and `af` for the joined
 * affiliate, because the country of an order is the country of its
 * affiliate and the resolver needs a column to compare. src/lib/cms/crm/
 * entityAccess.ts imports this rather than keeping a second copy, so the
 * activity engine and this module answer the access question identically.
 */
export async function scopedSalesOrders(db: Client, userId: string): Promise<Predicate> {
  const resolution = await resolveScope(db, userId, SALES_ORDER_VIEW);
  if (!resolution.granted) return DENY_ALL;
  return scopePredicate(resolution, {
    country: 'af.country_id',
    affiliate: 'so.affiliate_id',
    businessUnit: 'so.business_unit_id',
  });
}

/** The stage code the seeded sales order workflow gives finance approval. */
export const FINANCE_STAGE_CODE = 'FINANCE_APPROVAL';
export const CREDIT_STAGE_CODE = 'CREDIT_CHECK';

/**
 * The FROM and WHERE every query on this page shares.
 *
 * The date basis is the order's creation date, which is the default this
 * application states for every period figure. A metric measured on
 * completion says so in its own definition and passes its own column.
 */
export interface Population {
  source: string;
  where: string;
  args: (string | number)[];
}

export const SO_SOURCE = `sales_orders so
  JOIN affiliates af ON af.affiliate_id = so.affiliate_id
  JOIN accounts ac ON ac.account_id = so.account_id
  LEFT JOIN business_units bu ON bu.business_unit_id = so.business_unit_id`;

function productNarrowing(filter: AnalyticsFilter): SqlFragment {
  if (
    filter.productId === null &&
    filter.productCategoryId === null &&
    filter.productGroupId === null
  ) {
    return { sql: '1 = 1', args: [] };
  }
  // EXISTS rather than a join: an order with four lines must count once.
  const parts: string[] = [];
  const args: (string | number)[] = [];
  if (filter.productId !== null) {
    parts.push('p.product_id = ?');
    args.push(filter.productId);
  }
  if (filter.productCategoryId !== null) {
    parts.push('p.product_category_id = ?');
    args.push(filter.productCategoryId);
  }
  if (filter.productGroupId !== null) {
    parts.push('pc.product_group_id = ?');
    args.push(filter.productGroupId);
  }
  return {
    sql: `EXISTS (SELECT 1 FROM sales_order_lines sol
            JOIN products p ON p.product_id = sol.product_id
            JOIN product_categories pc ON pc.product_category_id = p.product_category_id
            WHERE sol.sales_order_id = so.sales_order_id AND ${parts.join(' AND ')})`,
    args,
  };
}

function slaNarrowing(filter: AnalyticsFilter, now: string): SqlFragment {
  if (filter.slaStatus === null) return { sql: '1 = 1', args: [] };
  const status = filter.slaStatus.toUpperCase();
  if (status === 'AT_RISK') {
    return {
      sql: `EXISTS (SELECT 1 FROM sla_instances si WHERE si.entity_type = 'SALES_ORDER'
              AND si.entity_id = so.sales_order_id AND si.status = 'RUNNING'
              AND si.warning_at IS NOT NULL AND si.warning_at <= ? AND si.target_at > ?)`,
      args: [now, now],
    };
  }
  return {
    sql: `EXISTS (SELECT 1 FROM sla_instances si WHERE si.entity_type = 'SALES_ORDER'
            AND si.entity_id = so.sales_order_id AND si.status = ?)`,
    args: [status],
  };
}

/**
 * Build the population once. Every caller in this module uses it, so a
 * filter added here reaches the list, the KPIs, the charts and the export
 * together and cannot reach one without the others.
 */
export async function soPopulation(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
  dateColumn = 'so.order_created_at',
): Promise<Population> {
  const scope = await scopedSalesOrders(db, userId);
  const combined = andAll([
    { sql: scope.sql, args: scope.args as (string | number)[] },
    dateWindow(dateColumn, filter),
    equals('af.country_id', filter.countryId),
    equals('so.affiliate_id', filter.affiliateId),
    equals('so.business_unit_id', filter.businessUnitId),
    equals('so.account_id', filter.accountId),
    equals('so.status', filter.status),
    equals('so.currency_code', filter.currency),
    filter.creditRequired === 'ANY'
      ? { sql: '1 = 1', args: [] }
      : { sql: `so.credit_approval_required = ?`, args: [filter.creditRequired === 'YES' ? 1 : 0] },
    productNarrowing(filter),
    slaNarrowing(filter, now),
    filter.stageCode === null
      ? { sql: '1 = 1', args: [] }
      : {
          sql: `EXISTS (SELECT 1 FROM workflow_instances wi
                  JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
                  JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
                  WHERE wi.entity_type = 'SALES_ORDER' AND wi.entity_id = so.sales_order_id
                    AND ws.stage_code = ? AND wsi.status IN ('PENDING','ACTIVE'))`,
          args: [filter.stageCode],
        },
  ]);
  return { source: SO_SOURCE, where: combined.sql, args: combined.args };
}

// ---- The operations list -----------------------------------------------------

export interface SalesOrderRow {
  salesOrderId: string;
  documentNumber: string;
  accountId: string;
  customerName: string;
  affiliateId: string;
  affiliateName: string;
  businessUnitName: string | null;
  orderCreatedAt: string;
  productSummary: string | null;
  currentStage: string | null;
  status: string;
  /** NULL where the stage never completed. Never zero. */
  financeMinutes: number | null;
  creditRequired: boolean;
  creditMinutes: number | null;
  invoiceCreatedAt: string | null;
  loadingAuthorityAt: string | null;
  loadedAt: string | null;
  slaStatus: string | null;
  currencyCode: string | null;
  orderValue: number | null;
}

const FINANCE_MINUTES = minutesBetweenSql('fin.started_at', 'fin.completed_at');
const CREDIT_MINUTES = minutesBetweenSql('crd.started_at', 'crd.completed_at');

const STAGE_JOINS = `
  LEFT JOIN workflow_instances wi
    ON wi.entity_type = 'SALES_ORDER' AND wi.entity_id = so.sales_order_id
  LEFT JOIN workflow_stage_instances fin
    ON fin.workflow_instance_id = wi.workflow_instance_id
   AND fin.workflow_stage_id = (SELECT ws.workflow_stage_id FROM workflow_stages ws
        WHERE ws.workflow_definition_id = wi.workflow_definition_id AND ws.stage_code = '${FINANCE_STAGE_CODE}')
  LEFT JOIN workflow_stage_instances crd
    ON crd.workflow_instance_id = wi.workflow_instance_id
   AND crd.workflow_stage_id = (SELECT ws.workflow_stage_id FROM workflow_stages ws
        WHERE ws.workflow_definition_id = wi.workflow_definition_id AND ws.stage_code = '${CREDIT_STAGE_CODE}')`;

export async function listSalesOrders(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
  limit = 200,
): Promise<SalesOrderRow[]> {
  const population = await soPopulation(db, userId, filter, now);
  const result = await db.execute({
    sql: `SELECT so.sales_order_id AS id, so.document_number AS doc, so.account_id AS account_id,
            ac.account_name AS customer, so.affiliate_id AS affiliate_id,
            af.affiliate_name AS affiliate, bu.business_unit_name AS business_unit,
            so.order_created_at AS created, so.status AS status,
            so.credit_approval_required AS credit_required,
            so.invoice_created_at AS invoiced, so.loading_authority_at AS loading_authority,
            so.loaded_at AS loaded, so.currency_code AS currency, so.order_value AS value,
            ${FINANCE_MINUTES} AS finance_minutes,
            ${CREDIT_MINUTES} AS credit_minutes,
            (SELECT ws.stage_name FROM workflow_stage_instances wsi
               JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
              WHERE wsi.workflow_instance_id = wi.workflow_instance_id
                AND wsi.status IN ('PENDING','ACTIVE')
              ORDER BY ws.sequence_no LIMIT 1) AS current_stage,
            (SELECT si.status FROM sla_instances si
              WHERE si.entity_type = 'SALES_ORDER' AND si.entity_id = so.sales_order_id
              ORDER BY CASE si.status WHEN 'BREACHED' THEN 0 WHEN 'RUNNING' THEN 1 ELSE 2 END
              LIMIT 1) AS sla_status,
            (SELECT GROUP_CONCAT(DISTINCT p.product_code) FROM sales_order_lines sol
               JOIN products p ON p.product_id = sol.product_id
              WHERE sol.sales_order_id = so.sales_order_id) AS products
          FROM ${population.source}${STAGE_JOINS}
          WHERE ${population.where}
          ORDER BY so.order_created_at DESC
          LIMIT ?`,
    args: [...population.args, limit] as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      salesOrderId: text(row.id),
      documentNumber: text(row.doc),
      accountId: text(row.account_id),
      customerName: text(row.customer),
      affiliateId: text(row.affiliate_id),
      affiliateName: text(row.affiliate),
      businessUnitName: nullableText(row.business_unit),
      orderCreatedAt: text(row.created),
      productSummary: nullableText(row.products),
      currentStage: nullableText(row.current_stage),
      status: text(row.status),
      financeMinutes: number(row.finance_minutes),
      creditRequired: Number(row.credit_required) === 1,
      creditMinutes: number(row.credit_minutes),
      invoiceCreatedAt: nullableText(row.invoiced),
      loadingAuthorityAt: nullableText(row.loading_authority),
      loadedAt: nullableText(row.loaded),
      slaStatus: nullableText(row.sla_status),
      currencyCode: nullableText(row.currency),
      orderValue: number(row.value),
    };
  });
}

/** The count of the same population, for proving a KPI and its list agree. */
export async function countSalesOrders(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<number> {
  const population = await soPopulation(db, userId, filter, now);
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM ${population.source} WHERE ${population.where}`,
    args: population.args as never[],
  });
  return Number((result.rows[0] as Record<string, unknown> | undefined)?.n ?? 0);
}

// ---- The performance figures -------------------------------------------------

export interface StageTurnaround {
  /** Wall clock, which is what the customer waited. */
  elapsed: DurationStats;
  /**
   * Pause-adjusted, which is what the SLA holds somebody to. Elapsed minus
   * the minutes the SLA engine recorded as paused, and never presented as
   * the same figure as elapsed.
   */
  accountable: DurationStats;
  /** How many of the measured orders carry an SLA instance for this stage. */
  slaCovered: number;
}

/**
 * The stage clock starts when the stage became actionable, which is the
 * persisted `started_at` on the stage instance, and stops when it completed.
 * NOT the spreadsheet's FINANCE_VARIANCE column, which is reconciliation
 * evidence and appears nowhere in this arithmetic.
 */
const stageElapsedSql = (alias: string) =>
  minutesBetweenSql(`${alias}.started_at`, `${alias}.completed_at`);

/**
 * Accountable minutes: the same interval less the paused minutes the engine
 * recorded on the matching SLA instance. Where a stage carries more than one
 * timer, the SMALLEST recorded pause is credited, which is the conservative
 * reading: it never flatters the accountable figure by crediting a pause
 * another rule allowed. Where a rule measures in business
 * hours the engine additionally excludes non-working time per record, and
 * the order detail view shows that exact figure; this aggregate states that
 * it is the pause-adjusted one.
 */
const stageAccountableSql = (alias: string) => `
  CASE WHEN ${alias}.started_at IS NULL OR ${alias}.completed_at IS NULL THEN NULL
       ELSE MAX(0, ((julianday(${alias}.completed_at) - julianday(${alias}.started_at)) * 1440.0)
            - COALESCE((SELECT MIN(si.paused_minutes) FROM sla_instances si
                         WHERE si.workflow_stage_instance_id = ${alias}.workflow_stage_instance_id), 0))
  END`;

async function stageTurnaround(
  db: Client,
  population: Population,
  alias: string,
  extraWhere: string,
): Promise<StageTurnaround> {
  const source = `${population.source}${STAGE_JOINS}`;
  const where = `${population.where}${extraWhere === '' ? '' : ` AND ${extraWhere}`}`;
  const [elapsed, accountable, covered] = await Promise.all([
    durationStats(db, { valueSql: stageElapsedSql(alias), source, where }, population.args),
    durationStats(db, { valueSql: stageAccountableSql(alias), source, where }, population.args),
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM ${source}
            WHERE ${where} AND EXISTS (SELECT 1 FROM sla_instances si
              WHERE si.workflow_stage_instance_id = ${alias}.workflow_stage_instance_id)`,
      args: population.args as never[],
    }),
  ]);
  return {
    elapsed,
    accountable,
    slaCovered: Number((covered.rows[0] as Record<string, unknown> | undefined)?.n ?? 0),
  };
}

export interface CreditPicture {
  /** Orders in the selection, whatever their credit position. */
  ordersInSelection: number;
  /** The denominator for every credit figure below: credit_approval_required = 1. */
  ordersRequiringCredit: number;
  /** Orders that never needed credit approval. NOT in the denominator. */
  ordersNotRequiringCredit: number;
  requiredRatePercent: number | null;
  turnaround: StageTurnaround;
  reasons: { reason: string; orders: number }[];
}

/**
 * Credit turnaround, with the denominator the whole business depends on.
 *
 * ONLY ORDERS WITH `credit_approval_required = 1` ARE IN THE POPULATION.
 * In the real extract 593 of 1,386 rows have every credit column blank,
 * which means credit approval was not required. Including those as zeroes
 * would roughly halve the median and make credit look twice as fast as it
 * is. They are counted separately, and reported as "Not required".
 */
export async function creditPicture(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<CreditPicture> {
  const population = await soPopulation(db, userId, filter, now);
  const counts = await db.execute({
    sql: `SELECT
            COUNT(*) AS all_orders,
            SUM(CASE WHEN so.credit_approval_required = 1 THEN 1 ELSE 0 END) AS required,
            SUM(CASE WHEN so.credit_approval_required = 0 THEN 1 ELSE 0 END) AS not_required
          FROM ${population.source} WHERE ${population.where}`,
    args: population.args as never[],
  });
  const row = (counts.rows[0] ?? {}) as unknown as Record<string, unknown>;
  const required = Number(row.required ?? 0);
  const notRequired = Number(row.not_required ?? 0);
  const all = Number(row.all_orders ?? 0);

  const turnaround = await stageTurnaround(
    db,
    population,
    'crd',
    'so.credit_approval_required = 1',
  );

  const reasons = await db.execute({
    sql: `SELECT COALESCE(so.credit_exception_reason, 'Not recorded') AS reason, COUNT(*) AS n
          FROM ${population.source}
          WHERE ${population.where} AND so.credit_approval_required = 1
          GROUP BY COALESCE(so.credit_exception_reason, 'Not recorded')
          ORDER BY COUNT(*) DESC`,
    args: population.args as never[],
  });

  return {
    ordersInSelection: all,
    ordersRequiringCredit: required,
    ordersNotRequiringCredit: notRequired,
    requiredRatePercent: rate(required, all),
    turnaround,
    reasons: reasons.rows.map((raw) => {
      const record = raw as unknown as Record<string, unknown>;
      return { reason: text(record.reason), orders: Number(record.n) };
    }),
  };
}

export interface FulfilmentDurations {
  /**
   * Order to invoice. The business calls this the depot loading measure, and
   * its definition is the invoice timestamp minus the order timestamp.
   */
  orderToInvoice: DurationStats;
  /** Order to loading authority: loading_authority_at minus order_created_at. */
  orderToLoadingAuthority: DurationStats;
  /**
   * Order to loaded: loaded_at minus order_created_at. A DIFFERENT metric
   * from the one above, and the extract carries no load timestamp at all, so
   * this reports "Not available" with its coverage rather than borrowing the
   * loading authority date.
   */
  orderToLoaded: DurationStats;
}

export async function fulfilmentDurations(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<FulfilmentDurations> {
  const population = await soPopulation(db, userId, filter, now);
  const measure = (from: string, to: string) =>
    durationStats(
      db,
      { valueSql: minutesBetweenSql(from, to), source: population.source, where: population.where },
      population.args,
    );
  const [orderToInvoice, orderToLoadingAuthority, orderToLoaded] = await Promise.all([
    measure('so.order_created_at', 'so.invoice_created_at'),
    measure('so.order_created_at', 'so.loading_authority_at'),
    measure('so.order_created_at', 'so.loaded_at'),
  ]);
  return { orderToInvoice, orderToLoadingAuthority, orderToLoaded };
}

export interface BacklogSignal {
  key: string;
  label: string;
  orders: number;
  /** The query string that opens the operations list showing exactly these. */
  drill: Record<string, string>;
}

/**
 * The backlog, every number drilling into the list that produced it. The
 * drill parameters are the filter this count was computed under, so the
 * destination population is the same population by construction.
 */
export async function backlog(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<BacklogSignal[]> {
  const population = await soPopulation(db, userId, filter, now);
  const result = await db.execute({
    sql: `SELECT
            SUM(CASE WHEN so.status = 'PENDING_FINANCE' THEN 1 ELSE 0 END) AS awaiting_finance,
            SUM(CASE WHEN so.status = 'PENDING_CREDIT' THEN 1 ELSE 0 END) AS awaiting_credit,
            SUM(CASE WHEN so.status = 'READY' THEN 1 ELSE 0 END) AS ready_to_invoice,
            SUM(CASE WHEN so.status = 'INVOICED' THEN 1 ELSE 0 END) AS awaiting_loading,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM sla_instances si
                  WHERE si.entity_type = 'SALES_ORDER' AND si.entity_id = so.sales_order_id
                    AND si.status = 'RUNNING' AND si.warning_at IS NOT NULL
                    AND si.warning_at <= ? AND si.target_at > ?) THEN 1 ELSE 0 END) AS at_risk,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM sla_instances si
                  WHERE si.entity_type = 'SALES_ORDER' AND si.entity_id = so.sales_order_id
                    AND si.status = 'BREACHED') THEN 1 ELSE 0 END) AS breached
          FROM ${population.source} WHERE ${population.where}`,
    args: [now, now, ...population.args] as never[],
  });
  const row = (result.rows[0] ?? {}) as unknown as Record<string, unknown>;
  return [
    {
      key: 'awaiting_finance',
      label: 'Awaiting finance approval',
      orders: Number(row.awaiting_finance ?? 0),
      drill: { status: 'PENDING_FINANCE' },
    },
    {
      key: 'awaiting_credit',
      label: 'Awaiting credit approval',
      orders: Number(row.awaiting_credit ?? 0),
      drill: { status: 'PENDING_CREDIT' },
    },
    {
      key: 'ready_to_invoice',
      label: 'Ready for invoice',
      orders: Number(row.ready_to_invoice ?? 0),
      drill: { status: 'READY' },
    },
    {
      key: 'awaiting_loading',
      label: 'Awaiting loading',
      orders: Number(row.awaiting_loading ?? 0),
      drill: { status: 'INVOICED' },
    },
    {
      key: 'at_risk',
      label: 'SLA at risk',
      orders: Number(row.at_risk ?? 0),
      drill: { slaStatus: 'AT_RISK' },
    },
    {
      key: 'breached',
      label: 'SLA breached',
      orders: Number(row.breached ?? 0),
      drill: { slaStatus: 'BREACHED' },
    },
  ];
}

/**
 * Age buckets for open orders, and they are DESCRIPTIVE.
 *
 * These boundaries are not SLA thresholds and the interface says so wherever
 * they appear. SLA status comes from the engine and from nowhere else; an
 * order four days old may be perfectly within a five-day target, and a
 * two-hour-old one may already have breached a one-hour target. The buckets
 * are chosen for the shape of this data, which spans months rather than the
 * minutes a same-day process would need.
 */
export const AGE_BUCKETS = [
  { key: 'under_1d', label: 'Under 1 day', from: 0, to: 1440 },
  { key: '1_3d', label: '1 to 3 days', from: 1440, to: 4320 },
  { key: '3_7d', label: '3 to 7 days', from: 4320, to: 10080 },
  { key: '7_30d', label: '7 to 30 days', from: 10080, to: 43200 },
  { key: 'over_30d', label: 'Over 30 days', from: 43200, to: null },
] as const;

export async function ageBuckets(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<{ key: string; label: string; orders: number }[]> {
  const population = await soPopulation(db, userId, filter, now);
  // The age is computed once in a subquery, so "now" is bound exactly once
  // and the bucket arithmetic reads as the boundaries it is.
  const cases = AGE_BUCKETS.map(
    (bucket) =>
      `SUM(CASE WHEN age >= ${bucket.from}` +
      (bucket.to === null ? '' : ` AND age < ${bucket.to}`) +
      ` THEN 1 ELSE 0 END) AS "${bucket.key}"`,
  ).join(', ');
  const result = await db.execute({
    sql: `SELECT ${cases} FROM (
            SELECT (julianday(?) - julianday(so.order_created_at)) * 1440.0 AS age
            FROM ${population.source}
            WHERE ${population.where} AND so.status NOT IN ('LOADED','CANCELLED'))`,
    args: [now, ...population.args] as never[],
  });
  const row = (result.rows[0] ?? {}) as unknown as Record<string, unknown>;
  return AGE_BUCKETS.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    orders: Number(row[bucket.key] ?? 0),
  }));
}

// ---- Approver performance ----------------------------------------------------

export interface ApproverRow {
  userId: string | null;
  approver: string;
  affiliateId: string | null;
  affiliateName: string | null;
  /** SALES_ORDER or PURCHASE_ORDER. Never blended into one figure. */
  processType: string;
  stageCode: string;
  stageName: string;
  transactions: number;
  medianMinutes: number | null;
  averageMinutes: number | null;
  p90Minutes: number | null;
  withinSlaPercent: number | null;
  breaches: number;
  pending: number;
  oldestPendingAt: string | null;
  /** False where volume is below the stated minimum: figures shown, no rank. */
  rankEligible: boolean;
  rank: number | null;
}

/**
 * Approver performance, and what it deliberately refuses to do.
 *
 * ONE PERSON, ONE PROCESS, ONE STAGE, ONE ROW. The grouping key is the user,
 * the workflow instance's entity type, the stage and the entity's affiliate.
 * A person who approves both sales orders and purchase orders gets two rows
 * and never one blended average, because the two processes have different
 * work in them and averaging them describes neither. Three people holding
 * the Finance Manager title in three affiliates are three rows for the same
 * reason: the job title is not the unit of analysis, the assignment is.
 *
 * NO SPEED RANKING. The table carries volume, median, P90, SLA compliance,
 * pending workload and the oldest pending item, and it is ordered by volume
 * so the reader sees who carries the load first. A comparative rank is shown
 * only above the stated minimum volume, so one transaction cannot outrank
 * three hundred, and a person below the minimum still sees their own
 * figures, without a rank beside them.
 */
export async function approverPerformance(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<{ rows: ApproverRow[]; minimumVolume: number }> {
  const population = await soPopulation(db, userId, filter, now);
  const result = await db.execute({
    sql: `SELECT
            wsi.assigned_user_id AS user_id,
            COALESCE(u.display_name, 'Unassigned') AS approver,
            so.affiliate_id AS affiliate_id,
            af.affiliate_name AS affiliate_name,
            wi.entity_type AS process_type,
            ws.stage_code AS stage_code,
            ws.stage_name AS stage_name,
            SUM(CASE WHEN wsi.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS transactions,
            AVG(CASE WHEN wsi.completed_at IS NOT NULL
                 THEN (julianday(wsi.completed_at) - julianday(wsi.started_at)) * 1440.0 END) AS average_minutes,
            SUM(CASE WHEN wsi.status IN ('PENDING','ACTIVE') THEN 1 ELSE 0 END) AS pending,
            MIN(CASE WHEN wsi.status IN ('PENDING','ACTIVE') THEN wsi.started_at END) AS oldest_pending,
            SUM(CASE WHEN si.status = 'BREACHED' THEN 1 ELSE 0 END) AS breaches,
            SUM(CASE WHEN si.status = 'MET' THEN 1 ELSE 0 END) AS met
          FROM ${population.source}
          JOIN workflow_instances wi
            ON wi.entity_type = 'SALES_ORDER' AND wi.entity_id = so.sales_order_id
          JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
          JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
          LEFT JOIN users u ON u.user_id = wsi.assigned_user_id
          LEFT JOIN sla_instances si ON si.workflow_stage_instance_id = wsi.workflow_stage_instance_id
          WHERE ${population.where}
          GROUP BY wsi.assigned_user_id, so.affiliate_id, wi.entity_type, ws.stage_code
          ORDER BY transactions DESC, approver`,
    args: population.args as never[],
  });

  // Median and P90 per group, from the same population, in one further pass.
  const percentiles = await db.execute({
    sql: `WITH measured AS (
            SELECT wsi.assigned_user_id AS user_id, so.affiliate_id AS affiliate_id,
                   wi.entity_type AS process_type, ws.stage_code AS stage_code,
                   (julianday(wsi.completed_at) - julianday(wsi.started_at)) * 1440.0 AS v
            FROM ${population.source}
            JOIN workflow_instances wi
              ON wi.entity_type = 'SALES_ORDER' AND wi.entity_id = so.sales_order_id
            JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
            JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
            WHERE ${population.where}
              AND wsi.completed_at IS NOT NULL AND wsi.started_at IS NOT NULL
          ),
          ranked AS (
            SELECT user_id, affiliate_id, process_type, stage_code, v,
                   ROW_NUMBER() OVER (PARTITION BY user_id, affiliate_id, process_type, stage_code ORDER BY v) AS rn,
                   COUNT(*) OVER (PARTITION BY user_id, affiliate_id, process_type, stage_code) AS c
            FROM measured
          )
          SELECT user_id, affiliate_id, process_type, stage_code,
                 MAX(CASE WHEN rn = (c + 1) / 2 THEN v END) AS median_minutes,
                 MAX(CASE WHEN rn = (c * 9 + 9) / 10 THEN v END) AS p90_minutes
          FROM ranked
          GROUP BY user_id, affiliate_id, process_type, stage_code`,
    args: population.args as never[],
  });
  const key = (parts: (string | null)[]) => parts.map((part) => part ?? '~').join('|');
  const byGroup = new Map<string, { median: number | null; p90: number | null }>();
  for (const raw of percentiles.rows) {
    const row = raw as unknown as Record<string, unknown>;
    byGroup.set(
      key([
        nullableText(row.user_id),
        nullableText(row.affiliate_id),
        text(row.process_type),
        text(row.stage_code),
      ]),
      { median: number(row.median_minutes), p90: number(row.p90_minutes) },
    );
  }

  const rows: ApproverRow[] = result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const stats = byGroup.get(
      key([
        nullableText(row.user_id),
        nullableText(row.affiliate_id),
        text(row.process_type),
        text(row.stage_code),
      ]),
    );
    const met = Number(row.met ?? 0);
    const breaches = Number(row.breaches ?? 0);
    const transactions = Number(row.transactions ?? 0);
    return {
      userId: nullableText(row.user_id),
      approver: text(row.approver),
      affiliateId: nullableText(row.affiliate_id),
      affiliateName: nullableText(row.affiliate_name),
      processType: text(row.process_type),
      stageCode: text(row.stage_code),
      stageName: text(row.stage_name),
      transactions,
      medianMinutes: stats?.median ?? null,
      averageMinutes: number(row.average_minutes),
      p90Minutes: stats?.p90 ?? null,
      withinSlaPercent: rate(met, met + breaches),
      breaches,
      pending: Number(row.pending ?? 0),
      oldestPendingAt: nullableText(row.oldest_pending),
      rankEligible: transactions >= filter.minVolume,
      rank: null,
    };
  });

  // The rank is awarded only among those above the minimum volume, and it is
  // by median turnaround within that group. Everybody else keeps their
  // figures and has no rank, which is the point.
  const eligible = rows
    .filter((row) => row.rankEligible && row.medianMinutes !== null)
    .sort((a, b) => (a.medianMinutes ?? 0) - (b.medianMinutes ?? 0));
  eligible.forEach((row, index) => {
    row.rank = index + 1;
  });
  return { rows, minimumVolume: filter.minVolume };
}

// ---- Products, customers, trend ----------------------------------------------

export interface ProductPerformanceRow {
  productGroupId: string | null;
  productGroupName: string | null;
  productCategoryId: string | null;
  productCategoryName: string | null;
  productId: string | null;
  productCode: string | null;
  orders: number;
  /** NULL where the extract carries no quantity, which is every imported row. */
  quantity: number | null;
  unitOfMeasure: string | null;
  medianOrderToInvoiceMinutes: number | null;
  creditExceptionRatePercent: number | null;
  slaCompliancePercent: number | null;
}

export async function productPerformance(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<ProductPerformanceRow[]> {
  const population = await soPopulation(db, userId, filter, now);
  const result = await db.execute({
    sql: `WITH lines AS (
            SELECT pg.product_group_id AS group_id, pg.group_name AS group_name,
                   pc.product_category_id AS category_id, pc.category_name AS category_name,
                   p.product_id AS product_id, p.product_code AS product_code,
                   p.unit_of_measure AS uom,
                   so.sales_order_id AS order_id,
                   so.credit_approval_required AS credit_required,
                   sol.quantity AS quantity,
                   (julianday(so.invoice_created_at) - julianday(so.order_created_at)) * 1440.0 AS to_invoice,
                   (SELECT si.status FROM sla_instances si
                     WHERE si.entity_type = 'SALES_ORDER' AND si.entity_id = so.sales_order_id
                     ORDER BY CASE si.status WHEN 'BREACHED' THEN 0 WHEN 'MET' THEN 1 ELSE 2 END
                     LIMIT 1) AS sla_status
            FROM ${population.source}
            JOIN sales_order_lines sol ON sol.sales_order_id = so.sales_order_id
            JOIN products p ON p.product_id = sol.product_id
            JOIN product_categories pc ON pc.product_category_id = p.product_category_id
            JOIN product_groups pg ON pg.product_group_id = pc.product_group_id
            WHERE ${population.where}
          ),
          ranked AS (
            SELECT product_id, to_invoice,
                   ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY to_invoice) AS rn,
                   COUNT(*) OVER (PARTITION BY product_id) AS c
            FROM lines WHERE to_invoice IS NOT NULL
          ),
          medians AS (
            SELECT product_id, MAX(CASE WHEN rn = (c + 1) / 2 THEN to_invoice END) AS median_minutes
            FROM ranked GROUP BY product_id
          )
          SELECT l.group_id, l.group_name, l.category_id, l.category_name,
                 l.product_id, l.product_code, l.uom,
                 COUNT(DISTINCT l.order_id) AS orders,
                 SUM(l.quantity) AS quantity,
                 (SELECT median_minutes FROM medians m WHERE m.product_id = l.product_id) AS median_to_invoice,
                 SUM(CASE WHEN l.credit_required = 1 THEN 1 ELSE 0 END) AS credit_orders,
                 SUM(CASE WHEN l.sla_status = 'MET' THEN 1 ELSE 0 END) AS met,
                 SUM(CASE WHEN l.sla_status = 'BREACHED' THEN 1 ELSE 0 END) AS breached
          FROM lines l
          GROUP BY l.group_id, l.category_id, l.product_id
          ORDER BY orders DESC`,
    args: population.args as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const orders = Number(row.orders ?? 0);
    const met = Number(row.met ?? 0);
    const breached = Number(row.breached ?? 0);
    return {
      productGroupId: nullableText(row.group_id),
      productGroupName: nullableText(row.group_name),
      productCategoryId: nullableText(row.category_id),
      productCategoryName: nullableText(row.category_name),
      productId: nullableText(row.product_id),
      productCode: nullableText(row.product_code),
      orders,
      // NULL stays NULL: the extract has no quantities, and a zero here
      // would claim the orders moved nothing.
      quantity: number(row.quantity),
      unitOfMeasure: nullableText(row.uom),
      medianOrderToInvoiceMinutes: number(row.median_to_invoice),
      creditExceptionRatePercent: rate(Number(row.credit_orders ?? 0), orders),
      slaCompliancePercent: rate(met, met + breached),
    };
  });
}

export interface CustomerPerformanceRow {
  accountId: string;
  customerName: string;
  orders: number;
  medianOrderToInvoiceMinutes: number | null;
  /** Present only where the caller may see credit information. */
  creditExceptionRatePercent: number | null;
  slaCompliancePercent: number | null;
}

/**
 * Customer analysis. Credit is commercially sensitive, so the credit column
 * is computed only for a caller who holds the credit permission; everybody
 * else gets null and the interface omits the column rather than showing an
 * empty one.
 */
export async function customerPerformance(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
  maySeeCredit: boolean,
): Promise<CustomerPerformanceRow[]> {
  const population = await soPopulation(db, userId, filter, now);
  const result = await db.execute({
    sql: `WITH orders AS (
            SELECT so.account_id AS account_id, ac.account_name AS customer,
                   so.sales_order_id AS order_id, so.credit_approval_required AS credit_required,
                   (julianday(so.invoice_created_at) - julianday(so.order_created_at)) * 1440.0 AS to_invoice,
                   (SELECT si.status FROM sla_instances si
                     WHERE si.entity_type = 'SALES_ORDER' AND si.entity_id = so.sales_order_id
                     ORDER BY CASE si.status WHEN 'BREACHED' THEN 0 WHEN 'MET' THEN 1 ELSE 2 END
                     LIMIT 1) AS sla_status
            FROM ${population.source} WHERE ${population.where}
          ),
          ranked AS (
            SELECT account_id, to_invoice,
                   ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY to_invoice) AS rn,
                   COUNT(*) OVER (PARTITION BY account_id) AS c
            FROM orders WHERE to_invoice IS NOT NULL
          ),
          medians AS (
            SELECT account_id, MAX(CASE WHEN rn = (c + 1) / 2 THEN to_invoice END) AS median_minutes
            FROM ranked GROUP BY account_id
          )
          SELECT o.account_id, o.customer, COUNT(*) AS orders,
                 (SELECT median_minutes FROM medians m WHERE m.account_id = o.account_id) AS median_to_invoice,
                 SUM(CASE WHEN o.credit_required = 1 THEN 1 ELSE 0 END) AS credit_orders,
                 SUM(CASE WHEN o.sla_status = 'MET' THEN 1 ELSE 0 END) AS met,
                 SUM(CASE WHEN o.sla_status = 'BREACHED' THEN 1 ELSE 0 END) AS breached
          FROM orders o GROUP BY o.account_id ORDER BY orders DESC LIMIT 100`,
    args: population.args as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const orders = Number(row.orders ?? 0);
    const met = Number(row.met ?? 0);
    const breached = Number(row.breached ?? 0);
    return {
      accountId: text(row.account_id),
      customerName: text(row.customer),
      orders,
      medianOrderToInvoiceMinutes: number(row.median_to_invoice),
      creditExceptionRatePercent: maySeeCredit
        ? rate(Number(row.credit_orders ?? 0), orders)
        : null,
      slaCompliancePercent: rate(met, met + breached),
    };
  });
}

export interface TrendBucket {
  bucket: string;
  orders: number;
  financeMedianMinutes: number | null;
  creditMedianMinutes: number | null;
  orderToInvoiceMedianMinutes: number | null;
  orderToLoadingAuthorityMedianMinutes: number | null;
  slaCompliancePercent: number | null;
}

export async function trend(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<TrendBucket[]> {
  const population = await soPopulation(db, userId, filter, now);
  const bucket = bucketExpression('so.order_created_at', filter.grain);
  const median = (column: string) =>
    `MAX(CASE WHEN ${column}_rn = (${column}_c + 1) / 2 THEN ${column} END)`;
  const result = await db.execute({
    sql: `WITH base AS (
            SELECT ${bucket} AS bucket,
                   ${stageElapsedSql('fin')} AS finance,
                   ${stageElapsedSql('crd')} AS credit,
                   (julianday(so.invoice_created_at) - julianday(so.order_created_at)) * 1440.0 AS to_invoice,
                   (julianday(so.loading_authority_at) - julianday(so.order_created_at)) * 1440.0 AS to_loading,
                   (SELECT si.status FROM sla_instances si
                     WHERE si.entity_type = 'SALES_ORDER' AND si.entity_id = so.sales_order_id
                     ORDER BY CASE si.status WHEN 'BREACHED' THEN 0 WHEN 'MET' THEN 1 ELSE 2 END
                     LIMIT 1) AS sla_status
            FROM ${population.source}${STAGE_JOINS}
            WHERE ${population.where}
          ),
          ranked AS (
            SELECT bucket, finance, credit, to_invoice, to_loading, sla_status,
              ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY finance) AS finance_rn,
              COUNT(finance) OVER (PARTITION BY bucket) AS finance_c,
              ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY credit) AS credit_rn,
              COUNT(credit) OVER (PARTITION BY bucket) AS credit_c,
              ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY to_invoice) AS to_invoice_rn,
              COUNT(to_invoice) OVER (PARTITION BY bucket) AS to_invoice_c,
              ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY to_loading) AS to_loading_rn,
              COUNT(to_loading) OVER (PARTITION BY bucket) AS to_loading_c
            FROM base
          )
          SELECT bucket, COUNT(*) AS orders,
                 ${median('finance')} AS finance_median,
                 ${median('credit')} AS credit_median,
                 ${median('to_invoice')} AS to_invoice_median,
                 ${median('to_loading')} AS to_loading_median,
                 SUM(CASE WHEN sla_status = 'MET' THEN 1 ELSE 0 END) AS met,
                 SUM(CASE WHEN sla_status = 'BREACHED' THEN 1 ELSE 0 END) AS breached
          FROM ranked GROUP BY bucket ORDER BY bucket`,
    args: population.args as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const met = Number(row.met ?? 0);
    const breached = Number(row.breached ?? 0);
    return {
      bucket: text(row.bucket),
      orders: Number(row.orders ?? 0),
      financeMedianMinutes: number(row.finance_median),
      creditMedianMinutes: number(row.credit_median),
      orderToInvoiceMedianMinutes: number(row.to_invoice_median),
      orderToLoadingAuthorityMedianMinutes: number(row.to_loading_median),
      slaCompliancePercent: rate(met, met + breached),
    };
  });
}

/**
 * Money, grouped by currency and never summed across them.
 *
 * KES, USD and UGX are not addable. There is no FX table in this schema and
 * inventing a rate would produce a number that is wrong by an unknown
 * amount, presented as if it were right. So every money figure carries its
 * currency and there is no total row.
 */
export interface CurrencyTotal {
  currencyCode: string | null;
  orders: number;
  totalValue: number | null;
}

export async function valueByCurrency(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<CurrencyTotal[]> {
  const population = await soPopulation(db, userId, filter, now);
  const result = await db.execute({
    sql: `SELECT so.currency_code AS currency, COUNT(*) AS orders, SUM(so.order_value) AS total
          FROM ${population.source} WHERE ${population.where}
          GROUP BY so.currency_code ORDER BY orders DESC`,
    args: population.args as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      currencyCode: nullableText(row.currency),
      orders: Number(row.orders ?? 0),
      totalValue: number(row.total),
    };
  });
}

// ---- The summary signals -----------------------------------------------------

export interface SoSummary {
  orders: number;
  finance: StageTurnaround;
  credit: CreditPicture;
  fulfilment: FulfilmentDurations;
  slaCompliancePercent: number | null;
  slaMeasured: number;
  backlog: BacklogSignal[];
  currencies: CurrencyTotal[];
}

/**
 * At most six signals, all under the same filter and the same scope. Each
 * one carries a coverage figure where it is a duration and a currency where
 * it is money, and each drills into the list that produced it.
 */
export async function soSummary(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<SoSummary> {
  const population = await soPopulation(db, userId, filter, now);
  const [orders, finance, credit, fulfilment, sla, backlogRows, currencies] = await Promise.all([
    countSalesOrders(db, userId, filter, now),
    stageTurnaround(db, population, 'fin', ''),
    creditPicture(db, userId, filter, now),
    fulfilmentDurations(db, userId, filter, now),
    db.execute({
      sql: `SELECT
              SUM(CASE WHEN si.status = 'MET' THEN 1 ELSE 0 END) AS met,
              SUM(CASE WHEN si.status = 'BREACHED' THEN 1 ELSE 0 END) AS breached
            FROM ${population.source}
            JOIN sla_instances si
              ON si.entity_type = 'SALES_ORDER' AND si.entity_id = so.sales_order_id
            WHERE ${population.where}`,
      args: population.args as never[],
    }),
    backlog(db, userId, filter, now),
    valueByCurrency(db, userId, filter, now),
  ]);
  const slaRow = (sla.rows[0] ?? {}) as unknown as Record<string, unknown>;
  const met = Number(slaRow.met ?? 0);
  const breached = Number(slaRow.breached ?? 0);
  return {
    orders,
    finance,
    credit,
    fulfilment,
    slaCompliancePercent: rate(met, met + breached),
    slaMeasured: met + breached,
    backlog: backlogRows,
    currencies,
  };
}

// ---- One order ---------------------------------------------------------------

export interface OrderStage {
  stageInstanceId: string;
  stageCode: string;
  stageName: string;
  sequenceNo: number;
  status: string;
  assignedUser: string | null;
  startedAt: string | null;
  completedAt: string | null;
  elapsedMinutes: number | null;
  slaInstanceId: string | null;
  slaStatus: string | null;
  pausedMinutes: number | null;
}

export interface OrderDetail {
  order: SalesOrderRow;
  lines: {
    lineNumber: number;
    productCode: string | null;
    productName: string | null;
    quantity: number | null;
    unitPrice: number | null;
    lineValue: number | null;
    unitOfMeasure: string | null;
  }[];
  stages: OrderStage[];
  /** The lifecycle, in the order it happens, with what is known of each step. */
  lifecycle: { step: string; at: string | null; note: string }[];
  /**
   * Every loading authority this order carried, earliest first.
   *
   * ONE ORDER LINE CAN BE LOADED MORE THAN ONCE, and `sales_orders` holds one
   * `loading_authority_at`. The column therefore records a CHOICE — the
   * earliest, by the rule the importer states — and this is the rest of what
   * there was, so the figure on screen is never mistaken for the whole story.
   * Read from the order's current snapshot, which the commit writes with the
   * full set beside the one it picked; empty for an order that predates this
   * or was not imported.
   */
  loadingAuthorities: string[];
  snapshots: { versionNo: number; capturedAt: string; isCurrent: boolean; snapshotJson: string }[];
}

/**
 * One order, under the same scope predicate as the list. An id from a
 * browser names nothing until this query has failed to find it under the
 * caller's scope.
 *
 * The analytics filter is deliberately absent: a detail view answers "may
 * this person open this record", which the scope decides, and narrowing it
 * by a date range the reader happened to have applied would hide a record
 * they are entitled to see.
 */
export async function orderDetail(
  db: Client,
  userId: string,
  salesOrderId: string,
): Promise<OrderDetail | null> {
  const scope = await scopedSalesOrders(db, userId);
  const found = await db.execute({
    sql: `SELECT so.sales_order_id AS id, so.document_number AS doc, so.account_id AS account_id,
            ac.account_name AS customer, so.affiliate_id AS affiliate_id,
            af.affiliate_name AS affiliate, bu.business_unit_name AS business_unit,
            so.order_created_at AS created, so.status AS status,
            so.credit_approval_required AS credit_required,
            so.credit_exception_reason AS credit_reason,
            so.invoice_number AS invoice_number,
            so.invoice_created_at AS invoiced, so.loading_authority_at AS loading_authority,
            so.loaded_at AS loaded, so.currency_code AS currency, so.order_value AS value
          FROM ${SO_SOURCE}
          WHERE so.sales_order_id = ? AND ${scope.sql} LIMIT 1`,
    args: [salesOrderId, ...scope.args] as never[],
  });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;

  const [lines, stages, snapshots] = await Promise.all([
    db.execute({
      sql: `SELECT sol.line_number, p.product_code, p.product_name, p.unit_of_measure,
              sol.quantity, sol.unit_price, sol.line_value
            FROM sales_order_lines sol
            LEFT JOIN products p ON p.product_id = sol.product_id
            WHERE sol.sales_order_id = ? ORDER BY sol.line_number`,
      args: [salesOrderId],
    }),
    db.execute({
      sql: `SELECT wsi.workflow_stage_instance_id AS id, ws.stage_code, ws.stage_name,
              ws.sequence_no, wsi.status, u.display_name AS assignee,
              wsi.started_at, wsi.completed_at,
              (julianday(wsi.completed_at) - julianday(wsi.started_at)) * 1440.0 AS elapsed,
              si.sla_instance_id, si.status AS sla_status, si.paused_minutes
            FROM workflow_instances wi
            JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
            JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
            LEFT JOIN users u ON u.user_id = wsi.assigned_user_id
            LEFT JOIN sla_instances si ON si.workflow_stage_instance_id = wsi.workflow_stage_instance_id
            WHERE wi.entity_type = 'SALES_ORDER' AND wi.entity_id = ?
            ORDER BY ws.sequence_no`,
      args: [salesOrderId],
    }),
    db.execute({
      sql: `SELECT version_no, captured_at, is_current, snapshot_json FROM record_snapshots
            WHERE entity_type = 'SALES_ORDER' AND entity_id = ? ORDER BY version_no DESC`,
      args: [salesOrderId],
    }),
  ]);

  const creditRequired = Number(row.credit_required) === 1;

  /**
   * The loading authorities the import recorded for this order.
   *
   * From the CURRENT snapshot, which the commit writes with the whole set
   * beside the one it chose. Read from there rather than from
   * `so_extract_rows`, which is keyed by batch and row number and has no index
   * that answers "this order" — a scan of every landed row on every order page
   * is not a cost a detail view should carry.
   *
   * Anything unreadable, absent or of the wrong shape yields an empty list and
   * the page falls back to the plain note. A snapshot written before this
   * phase has no such field, and that is not an error.
   */
  const loadingAuthorities: string[] = (() => {
    const current = snapshots.rows.find(
      (raw) => Number((raw as unknown as Record<string, unknown>).is_current) === 1,
    );
    if (current === undefined) return [];
    try {
      const parsed = JSON.parse(
        text((current as unknown as Record<string, unknown>).snapshot_json),
      ) as { loadingAuthorities?: unknown };
      if (!Array.isArray(parsed.loadingAuthorities)) return [];
      return parsed.loadingAuthorities.filter((v): v is string => typeof v === 'string').sort();
    } catch {
      return [];
    }
  })();
  const stageRows: OrderStage[] = stages.rows.map((raw) => {
    const record = raw as unknown as Record<string, unknown>;
    return {
      stageInstanceId: text(record.id),
      stageCode: text(record.stage_code),
      stageName: text(record.stage_name),
      sequenceNo: Number(record.sequence_no),
      status: text(record.status),
      assignedUser: nullableText(record.assignee),
      startedAt: nullableText(record.started_at),
      completedAt: nullableText(record.completed_at),
      elapsedMinutes: number(record.elapsed),
      slaInstanceId: nullableText(record.sla_instance_id),
      slaStatus: nullableText(record.sla_status),
      pausedMinutes: number(record.paused_minutes),
    };
  });

  const financeStage = stageRows.find((stage) => stage.stageCode === FINANCE_STAGE_CODE);
  const creditStage = stageRows.find((stage) => stage.stageCode === CREDIT_STAGE_CODE);

  return {
    order: {
      salesOrderId: text(row.id),
      documentNumber: text(row.doc),
      accountId: text(row.account_id),
      customerName: text(row.customer),
      affiliateId: text(row.affiliate_id),
      affiliateName: text(row.affiliate),
      businessUnitName: nullableText(row.business_unit),
      orderCreatedAt: text(row.created),
      productSummary: null,
      currentStage: stageRows.find((stage) => stage.status === 'ACTIVE')?.stageName ?? null,
      status: text(row.status),
      financeMinutes: financeStage?.elapsedMinutes ?? null,
      creditRequired,
      creditMinutes: creditStage?.elapsedMinutes ?? null,
      invoiceCreatedAt: nullableText(row.invoiced),
      loadingAuthorityAt: nullableText(row.loading_authority),
      loadedAt: nullableText(row.loaded),
      slaStatus: null,
      currencyCode: nullableText(row.currency),
      orderValue: number(row.value),
    },
    lines: lines.rows.map((raw) => {
      const record = raw as unknown as Record<string, unknown>;
      return {
        lineNumber: Number(record.line_number),
        productCode: nullableText(record.product_code),
        productName: nullableText(record.product_name),
        quantity: number(record.quantity),
        unitPrice: number(record.unit_price),
        lineValue: number(record.line_value),
        unitOfMeasure: nullableText(record.unit_of_measure),
      };
    }),
    stages: stageRows,
    // The lifecycle, step by step. Where credit was not required the step
    // says "Not required", which is a different statement from "0 min" and
    // the one the data actually supports.
    loadingAuthorities,
    lifecycle: [
      { step: 'Created', at: text(row.created), note: 'The order was raised.' },
      {
        step: 'Finance approval',
        at: financeStage?.completedAt ?? null,
        note:
          financeStage === undefined
            ? 'No finance stage recorded.'
            : financeStage.completedAt === null
              ? 'Awaiting finance approval.'
              : 'Finance approval completed.',
      },
      {
        step: 'Credit approval',
        at: creditStage?.completedAt ?? null,
        note: !creditRequired
          ? 'Not required.'
          : creditStage?.completedAt === null || creditStage === undefined
            ? 'Awaiting credit approval.'
            : 'Credit approval completed.',
      },
      {
        step: 'Invoice',
        at: nullableText(row.invoiced),
        note: row.invoiced === null ? 'Not available.' : `Invoice ${text(row.invoice_number)}.`,
      },
      {
        step: 'Loading authority',
        at: nullableText(row.loading_authority),
        // THE RULE, BESIDE THE FIGURE. A reader seeing one timestamp on an
        // order that was loaded seven times has been told something false by
        // omission, and the number feeds the order-to-loading-authority
        // metric, so it has to say which of the seven it is.
        note:
          row.loading_authority === null
            ? 'Not available.'
            : loadingAuthorities.length > 1
              ? `The earliest of ${loadingAuthorities.length} loading authorities on this order, ` +
                `the last being ${loadingAuthorities[loadingAuthorities.length - 1]}. ` +
                `Every one is kept in the imported rows.`
              : 'Loading authority issued.',
      },
      {
        step: 'Loaded',
        at: nullableText(row.loaded),
        note:
          row.loaded === null
            ? 'Not available. This extract carries no load timestamp, and the loading authority date is not a substitute.'
            : 'Loaded.',
      },
    ],
    snapshots: snapshots.rows.map((raw) => {
      const record = raw as unknown as Record<string, unknown>;
      return {
        versionNo: Number(record.version_no),
        capturedAt: text(record.captured_at),
        isCurrent: Number(record.is_current) === 1,
        snapshotJson: text(record.snapshot_json),
      };
    }),
  };
}

// ---- Export ------------------------------------------------------------------

/**
 * A cell safe to open in a spreadsheet.
 *
 * A value beginning with =, +, - or @ is a formula to Excel, so an imported
 * customer name of "=cmd|' /c calc'!A1" would execute on the machine of
 * whoever opens the export. The prefix apostrophe makes it text. The quoting
 * is the ordinary CSV kind and is separate from this.
 */
export function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const defused = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${defused.replace(/"/g, '""')}"`;
}

/**
 * The filtered detail as CSV, under the caller's own scope, with the filters
 * and the generation time written into the file so a printed copy can say
 * what it is a copy of. Nothing outside the caller's scope is exported,
 * because the rows come from the same population as the list.
 */
export async function exportCsv(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
  filterDescription: string,
): Promise<string> {
  const rows = await listSalesOrders(db, userId, filter, now, 5000);
  const header = [
    'Order number',
    'Customer',
    'Affiliate',
    'Business unit',
    'Created',
    'Status',
    'Current stage',
    'Finance minutes (elapsed)',
    'Credit required',
    'Credit minutes (elapsed)',
    'Invoice created',
    'Loading authority',
    'Loaded',
    'SLA status',
    'Currency',
    'Order value',
  ];
  const lines = [
    `# Hass Petroleum CMS sales order export`,
    `# Generated ${now} UTC`,
    `# Filters: ${filterDescription}`,
    `# Values absent from the source are written as "Not available", never as zero.`,
    header.map(csvCell).join(','),
    ...rows.map((row) =>
      [
        row.documentNumber,
        row.customerName,
        row.affiliateName,
        row.businessUnitName ?? 'Not available',
        row.orderCreatedAt,
        row.status,
        row.currentStage ?? 'Not available',
        row.financeMinutes === null ? 'Not available' : Math.round(row.financeMinutes),
        row.creditRequired ? 'Yes' : 'No',
        !row.creditRequired
          ? 'Not required'
          : row.creditMinutes === null
            ? 'Not available'
            : Math.round(row.creditMinutes),
        row.invoiceCreatedAt ?? 'Not available',
        row.loadingAuthorityAt ?? 'Not available',
        row.loadedAt ?? 'Not available',
        row.slaStatus ?? 'Not available',
        row.currencyCode ?? 'Not available',
        row.orderValue === null ? 'Not available' : row.orderValue,
      ]
        .map(csvCell)
        .join(','),
    ),
  ];
  return lines.join('\r\n');
}
