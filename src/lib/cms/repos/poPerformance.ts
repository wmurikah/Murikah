/**
 * Purchase order and stock process performance.
 *
 * WHY THIS PROCESS IS MEASURED AT ALL.
 * Physical stock and Oracle stock have to agree. A purchase order that has
 * been received in the yard but not posted in the system leaves the system
 * believing there is nothing to sell, and a customer order then waits for
 * stock that is physically already there. The creation-to-posting figures
 * below are the measure of how fast the system catches up with the yard, and
 * they are the reason this page exists.
 *
 * NOTHING IS ASSUMED TO HAVE FOUR STAGES.
 * The extract happens to use four levels in all 45 orders, and the template
 * allows seven. Every query here reads the stages the workflow instance
 * actually has. A stage exists when its instance exists; an empty approver
 * column is not an elapsed stage and is never drawn as one.
 *
 * NOTHING IS INVENTED.
 * Supplier, currency and value are NULL on every imported order because the
 * extract carries none of them, and both stock timestamps are NULL as well.
 * Every metric built on them reports "Not available" with its coverage, and
 * the final approval date is never borrowed to stand in for a posting date.
 *
 * THE SOURCE VARIANCE COLUMNS ARE NOT HERE.
 * TIME_DIFF_RAISEPO_TOAPROVALSUBMIT and every *_APPROVALS_VARIANCE stay on
 * the source history view as reconciliation evidence. Phase 18 measured that
 * they accumulate from submission while a stage duration does not, so using
 * them as a stage metric would overstate every stage after the first.
 */
import type { Client } from '@libsql/client/web';
import { resolveScope, scopePredicate, DENY_ALL, type Predicate } from '../auth/rbac.ts';
import { SALES_ORDER_VIEW } from '../permissions.ts';
import { PURCHASE_ORDER_VIEW } from '../permissions.ts';
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
 * The purchase order scope, canonical here. Alias contract: `po` for the
 * order and `af` for its affiliate, matching the sales order module so the
 * two read the same way.
 */
export async function scopedPurchaseOrders(db: Client, userId: string): Promise<Predicate> {
  const resolution = await resolveScope(db, userId, PURCHASE_ORDER_VIEW);
  if (!resolution.granted) return DENY_ALL;
  return scopePredicate(resolution, {
    country: 'af.country_id',
    affiliate: 'po.affiliate_id',
    businessUnit: 'po.business_unit_id',
  });
}

export const PO_SOURCE = `purchase_orders po
  JOIN affiliates af ON af.affiliate_id = po.affiliate_id
  LEFT JOIN business_units bu ON bu.business_unit_id = po.business_unit_id`;

export interface Population {
  source: string;
  where: string;
  args: (string | number)[];
}

function productNarrowing(filter: AnalyticsFilter): SqlFragment {
  if (
    filter.productId === null &&
    filter.productCategoryId === null &&
    filter.productGroupId === null
  ) {
    return { sql: '1 = 1', args: [] };
  }
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
    sql: `EXISTS (SELECT 1 FROM purchase_order_lines pol
            JOIN products p ON p.product_id = pol.product_id
            JOIN product_categories pc ON pc.product_category_id = p.product_category_id
            WHERE pol.purchase_order_id = po.purchase_order_id AND ${parts.join(' AND ')})`,
    args,
  };
}

export async function poPopulation(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<Population> {
  const scope = await scopedPurchaseOrders(db, userId);
  const combined = andAll([
    { sql: scope.sql, args: scope.args as (string | number)[] },
    dateWindow('po.po_created_at', filter),
    equals('af.country_id', filter.countryId),
    equals('po.affiliate_id', filter.affiliateId),
    equals('po.business_unit_id', filter.businessUnitId),
    equals('po.status', filter.status),
    equals('po.supplier_name', filter.supplier),
    equals('po.currency_code', filter.currency),
    productNarrowing(filter),
    filter.slaStatus === null
      ? { sql: '1 = 1', args: [] }
      : filter.slaStatus.toUpperCase() === 'AT_RISK'
        ? {
            sql: `EXISTS (SELECT 1 FROM sla_instances si WHERE si.entity_type = 'PURCHASE_ORDER'
                    AND si.entity_id = po.purchase_order_id AND si.status = 'RUNNING'
                    AND si.warning_at IS NOT NULL AND si.warning_at <= ? AND si.target_at > ?)`,
            args: [now, now],
          }
        : {
            sql: `EXISTS (SELECT 1 FROM sla_instances si WHERE si.entity_type = 'PURCHASE_ORDER'
                    AND si.entity_id = po.purchase_order_id AND si.status = ?)`,
            args: [filter.slaStatus.toUpperCase()],
          },
    filter.stageCode === null
      ? { sql: '1 = 1', args: [] }
      : {
          sql: `EXISTS (SELECT 1 FROM workflow_instances wi
                  JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
                  JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
                  WHERE wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id
                    AND ws.stage_code = ?)`,
          args: [filter.stageCode],
        },
    filter.ownerId === null
      ? { sql: '1 = 1', args: [] }
      : {
          sql: `EXISTS (SELECT 1 FROM workflow_instances wi
                  JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
                  WHERE wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id
                    AND wsi.assigned_user_id = ?)`,
          args: [filter.ownerId],
        },
  ]);
  return { source: PO_SOURCE, where: combined.sql, args: combined.args };
}

/**
 * The stage view every duration on this page is built from.
 *
 * `actionable_at` is the moment the stage became answerable, and the order
 * of preference matters. The persisted timestamp on the stage instance comes
 * first, because a workflow that is not sequential knows its own answer and
 * a positional guess would be wrong. Only where nothing is persisted does
 * this fall back to the definition's own sequence: the submission timestamp
 * for the first stage, and the previous stage's completion for the rest.
 *
 * NOTE WHAT THE FIRST STAGE IS MEASURED FROM. It is
 * `purchase_orders.submitted_for_approval_at`, never the creation date.
 * Creation to submission is a separate figure with its own meaning, reported
 * separately below, and adding it into stage one would blame the first
 * approver for the time the requester took.
 */
export const STAGE_VIEW = `
  SELECT po.purchase_order_id AS purchase_order_id,
         po.affiliate_id AS affiliate_id,
         wsi.workflow_stage_instance_id AS stage_instance_id,
         ws.stage_code AS stage_code,
         ws.stage_name AS stage_name,
         ws.sequence_no AS sequence_no,
         wsi.status AS stage_status,
         wsi.assigned_user_id AS assigned_user_id,
         wsi.completed_at AS completed_at,
         COALESCE(
           wsi.started_at,
           wsi.assigned_at,
           CASE WHEN ws.sequence_no = MIN(ws.sequence_no) OVER (PARTITION BY wi.workflow_instance_id)
                THEN po.submitted_for_approval_at
                ELSE LAG(wsi.completed_at) OVER (
                       PARTITION BY wi.workflow_instance_id ORDER BY ws.sequence_no)
           END
         ) AS actionable_at
  FROM {SOURCE}
  JOIN workflow_instances wi
    ON wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id
  JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
  JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
  WHERE {WHERE}`;

function stageView(population: Population): string {
  return STAGE_VIEW.replace('{SOURCE}', population.source).replace('{WHERE}', population.where);
}

// ---- The operations list -----------------------------------------------------

export interface PurchaseOrderRow {
  purchaseOrderId: string;
  documentNumber: string;
  affiliateId: string;
  affiliateName: string;
  businessUnitName: string | null;
  /** NULL on every imported order: the extract carries no supplier. */
  supplierName: string | null;
  productSummary: string | null;
  poCreatedAt: string;
  submittedForApprovalAt: string | null;
  currentStage: string | null;
  currentApprover: string | null;
  status: string;
  physicalReceivedAt: string | null;
  oracleStockPostedAt: string | null;
  awaitingOraclePosting: boolean;
  slaStatus: string | null;
  currencyCode: string | null;
  poValue: number | null;
  approvalStagesRecorded: number;
}

export async function listPurchaseOrders(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
  limit = 200,
): Promise<PurchaseOrderRow[]> {
  const population = await poPopulation(db, userId, filter, now);
  const result = await db.execute({
    sql: `SELECT po.purchase_order_id AS id, po.document_number AS doc,
            po.affiliate_id AS affiliate_id, af.affiliate_name AS affiliate,
            bu.business_unit_name AS business_unit, po.supplier_name AS supplier,
            po.po_created_at AS created, po.submitted_for_approval_at AS submitted,
            po.status AS status, po.physical_received_at AS received,
            po.oracle_stock_posted_at AS posted, po.currency_code AS currency,
            po.po_value AS value,
            (SELECT GROUP_CONCAT(DISTINCT p.product_code) FROM purchase_order_lines pol
               JOIN products p ON p.product_id = pol.product_id
              WHERE pol.purchase_order_id = po.purchase_order_id) AS products,
            (SELECT ws.stage_name FROM workflow_instances wi
               JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
               JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
              WHERE wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id
                AND wsi.status IN ('PENDING','ACTIVE')
              ORDER BY ws.sequence_no LIMIT 1) AS current_stage,
            (SELECT u.display_name FROM workflow_instances wi
               JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
               JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
               LEFT JOIN users u ON u.user_id = wsi.assigned_user_id
              WHERE wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id
                AND wsi.status IN ('PENDING','ACTIVE')
              ORDER BY ws.sequence_no LIMIT 1) AS current_approver,
            (SELECT COUNT(*) FROM workflow_instances wi
               JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
              WHERE wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id) AS stages,
            (SELECT si.status FROM sla_instances si
              WHERE si.entity_type = 'PURCHASE_ORDER' AND si.entity_id = po.purchase_order_id
              ORDER BY CASE si.status WHEN 'BREACHED' THEN 0 WHEN 'RUNNING' THEN 1 ELSE 2 END
              LIMIT 1) AS sla_status
          FROM ${population.source}
          WHERE ${population.where}
          ORDER BY po.po_created_at DESC LIMIT ?`,
    args: [...population.args, limit] as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const received = nullableText(row.received);
    const posted = nullableText(row.posted);
    return {
      purchaseOrderId: text(row.id),
      documentNumber: text(row.doc),
      affiliateId: text(row.affiliate_id),
      affiliateName: text(row.affiliate),
      businessUnitName: nullableText(row.business_unit),
      supplierName: nullableText(row.supplier),
      productSummary: nullableText(row.products),
      poCreatedAt: text(row.created),
      submittedForApprovalAt: nullableText(row.submitted),
      currentStage: nullableText(row.current_stage),
      currentApprover: nullableText(row.current_approver),
      status: text(row.status),
      physicalReceivedAt: received,
      oracleStockPostedAt: posted,
      // The flag the yard cares about: goods are here, the system does not
      // know it yet.
      awaitingOraclePosting: received !== null && posted === null,
      slaStatus: nullableText(row.sla_status),
      currencyCode: nullableText(row.currency),
      poValue: number(row.value),
      approvalStagesRecorded: Number(row.stages ?? 0),
    };
  });
}

export async function countPurchaseOrders(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<number> {
  const population = await poPopulation(db, userId, filter, now);
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM ${population.source} WHERE ${population.where}`,
    args: population.args as never[],
  });
  return Number((result.rows[0] as Record<string, unknown> | undefined)?.n ?? 0);
}

// ---- Stage turnaround, dynamic ------------------------------------------------

export interface StageRow {
  stageCode: string;
  stageName: string;
  sequenceNo: number;
  /** Stage instances that exist. A level nobody used has no row here at all. */
  recorded: number;
  completed: number;
  pending: number;
  medianMinutes: number | null;
  averageMinutes: number | null;
  p90Minutes: number | null;
  oldestPendingAt: string | null;
}

/**
 * Every stage the selected orders actually used, in sequence order, with its
 * own turnaround. Seven levels or three, the query is the same: it reads
 * what exists rather than what a template allows.
 */
export async function stagePerformance(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<StageRow[]> {
  const population = await poPopulation(db, userId, filter, now);
  const result = await db.execute({
    sql: `WITH stages AS (${stageView(population)}),
          measured AS (
            SELECT stage_code, stage_name, sequence_no,
                   ${minutesBetweenSql('actionable_at', 'completed_at')} AS v
            FROM stages
          ),
          ranked AS (
            SELECT stage_code, v,
                   ROW_NUMBER() OVER (PARTITION BY stage_code ORDER BY v) AS rn,
                   COUNT(*) OVER (PARTITION BY stage_code) AS c
            FROM measured WHERE v IS NOT NULL
          ),
          percentiles AS (
            SELECT stage_code,
                   MAX(CASE WHEN rn = (c + 1) / 2 THEN v END) AS median_minutes,
                   MAX(CASE WHEN rn = (c * 9 + 9) / 10 THEN v END) AS p90_minutes
            FROM ranked GROUP BY stage_code
          )
          SELECT s.stage_code, s.stage_name, s.sequence_no,
                 COUNT(*) AS recorded,
                 SUM(CASE WHEN s.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed,
                 SUM(CASE WHEN s.stage_status IN ('PENDING','ACTIVE') THEN 1 ELSE 0 END) AS pending,
                 MIN(CASE WHEN s.stage_status IN ('PENDING','ACTIVE') THEN s.actionable_at END) AS oldest_pending,
                 AVG(${minutesBetweenSql('s.actionable_at', 's.completed_at')}) AS average_minutes,
                 (SELECT median_minutes FROM percentiles p WHERE p.stage_code = s.stage_code) AS median_minutes,
                 (SELECT p90_minutes FROM percentiles p WHERE p.stage_code = s.stage_code) AS p90_minutes
          FROM stages s
          GROUP BY s.stage_code, s.sequence_no
          ORDER BY s.sequence_no`,
    args: population.args as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      stageCode: text(row.stage_code),
      stageName: text(row.stage_name),
      sequenceNo: Number(row.sequence_no),
      recorded: Number(row.recorded ?? 0),
      completed: Number(row.completed ?? 0),
      pending: Number(row.pending ?? 0),
      medianMinutes: number(row.median_minutes),
      averageMinutes: number(row.average_minutes),
      p90Minutes: number(row.p90_minutes),
      oldestPendingAt: nullableText(row.oldest_pending),
    };
  });
}

export interface BottleneckRow {
  stageCode: string;
  stageName: string;
  sequenceNo: number;
  medianMinutes: number | null;
  /** This stage's median as a share of the sum of all stage medians. */
  sharePercent: number | null;
}

/**
 * How much of the approval cycle each stage accounts for.
 *
 * THE METHOD, WHICH THE INTERFACE ALSO STATES.
 * Each stage's MEDIAN duration is taken, and the share is that median
 * divided by the sum of all the stage medians. It is not a mean of shares,
 * and it is not a share of means. A reader shown a percentage will assume a
 * mean unless told otherwise, and a mean here would let one order that sat
 * for three weeks at stage two rewrite the whole picture.
 *
 * The shares therefore sum to 100 per cent by construction, and the figure
 * is a statement about the typical order rather than about the total time
 * spent.
 */
export const BOTTLENECK_METHOD =
  "Each stage's median duration as a share of the sum of the stage medians. Medians, not means, so one order that sat for three weeks cannot rewrite the picture, and the shares describe the typical order rather than total time spent.";

export async function bottleneck(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<{ rows: BottleneckRow[]; method: string }> {
  const stages = await stagePerformance(db, userId, filter, now);
  const total = stages.reduce((sum, stage) => sum + (stage.medianMinutes ?? 0), 0);
  return {
    method: BOTTLENECK_METHOD,
    rows: stages.map((stage) => ({
      stageCode: stage.stageCode,
      stageName: stage.stageName,
      sequenceNo: stage.sequenceNo,
      medianMinutes: stage.medianMinutes,
      sharePercent:
        total === 0 || stage.medianMinutes === null
          ? null
          : Math.round((stage.medianMinutes / total) * 1000) / 10,
    })),
  };
}

// ---- The whole-order durations -----------------------------------------------

export interface PoDurationSet {
  /** Creation to submission. Reported separately and never folded into stage one. */
  creationToSubmission: DurationStats;
  /**
   * Submission to the final recorded approval, for COMPLETED orders only. A
   * pending order has not finished its cycle and belongs in backlog ageing,
   * not in a completed-cycle average where it would drag the figure down
   * while still running.
   */
  approvalCycle: DurationStats;
  approvalToPhysicalReceipt: DurationStats;
  creationToPhysicalReceipt: DurationStats;
  /** The measure of how fast the system catches up with the yard. */
  physicalReceiptToOraclePosting: DurationStats;
  creationToOraclePosting: DurationStats;
}

export async function durations(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<PoDurationSet> {
  const population = await poPopulation(db, userId, filter, now);
  const measure = (valueSql: string, where = population.where) =>
    durationStats(db, { valueSql, source: population.source, where }, population.args);

  // The final approval per order, from the stages that exist.
  const finalApproval = `(SELECT MAX(wsi.completed_at) FROM workflow_instances wi
      JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
      WHERE wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id)`;
  const noneOutstanding = `NOT EXISTS (SELECT 1 FROM workflow_instances wi
      JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
      WHERE wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id
        AND wsi.completed_at IS NULL)`;

  const [
    creationToSubmission,
    approvalCycle,
    approvalToPhysicalReceipt,
    creationToPhysicalReceipt,
    physicalReceiptToOraclePosting,
    creationToOraclePosting,
  ] = await Promise.all([
    measure(minutesBetweenSql('po.po_created_at', 'po.submitted_for_approval_at')),
    measure(
      minutesBetweenSql('po.submitted_for_approval_at', finalApproval),
      `${population.where} AND ${noneOutstanding}`,
    ),
    measure(minutesBetweenSql(finalApproval, 'po.physical_received_at')),
    measure(minutesBetweenSql('po.po_created_at', 'po.physical_received_at')),
    measure(minutesBetweenSql('po.physical_received_at', 'po.oracle_stock_posted_at')),
    measure(minutesBetweenSql('po.po_created_at', 'po.oracle_stock_posted_at')),
  ]);
  return {
    creationToSubmission,
    approvalCycle,
    approvalToPhysicalReceipt,
    creationToPhysicalReceipt,
    physicalReceiptToOraclePosting,
    creationToOraclePosting,
  };
}

export interface CoverageRow {
  label: string;
  present: number;
  total: number;
  percent: number | null;
  note: string;
}

/**
 * Data coverage, and it is shown ABOVE the durations rather than below them.
 *
 * In an early implementation this is the most important panel on the page.
 * A median receipt-to-posting time computed over two of forty-five orders is
 * not wrong arithmetic, it is a wrong impression, and the only defence is to
 * put the denominator in front of the reader before the figure.
 */
export async function coverage(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<CoverageRow[]> {
  const population = await poPopulation(db, userId, filter, now);
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS total,
            SUM(CASE WHEN po.submitted_for_approval_at IS NOT NULL THEN 1 ELSE 0 END) AS submitted,
            SUM(CASE WHEN po.physical_received_at IS NOT NULL THEN 1 ELSE 0 END) AS received,
            SUM(CASE WHEN po.oracle_stock_posted_at IS NOT NULL THEN 1 ELSE 0 END) AS posted,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM workflow_instances wi
                  JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
                  WHERE wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id)
                 THEN 1 ELSE 0 END) AS with_stages,
            SUM(CASE WHEN po.supplier_name IS NOT NULL THEN 1 ELSE 0 END) AS with_supplier,
            SUM(CASE WHEN po.po_value IS NOT NULL THEN 1 ELSE 0 END) AS with_value
          FROM ${population.source} WHERE ${population.where}`,
    args: population.args as never[],
  });
  const row = (result.rows[0] ?? {}) as unknown as Record<string, unknown>;
  const total = Number(row.total ?? 0);
  const line = (label: string, present: number, note: string): CoverageRow => ({
    label,
    present,
    total,
    percent: rate(present, total),
    note,
  });
  return [
    line(
      'Submitted for approval',
      Number(row.submitted ?? 0),
      'Stage one is measured from this timestamp, so a metric on an order without it is not available.',
    ),
    line(
      'Complete stage history',
      Number(row.with_stages ?? 0),
      'Orders with at least one recorded approval stage.',
    ),
    line(
      'Physical receipt recorded',
      Number(row.received ?? 0),
      'Without it, receipt durations are not available rather than zero.',
    ),
    line(
      'Oracle stock posted',
      Number(row.posted ?? 0),
      'The measure of how fast system stock catches up with physical stock.',
    ),
    line('Supplier recorded', Number(row.with_supplier ?? 0), 'The extract carries no supplier.'),
    line('Value recorded', Number(row.with_value ?? 0), 'The extract carries no order value.'),
  ];
}

export interface PoBacklogSignal {
  key: string;
  label: string;
  orders: number;
  drill: Record<string, string>;
}

export async function backlog(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<PoBacklogSignal[]> {
  const population = await poPopulation(db, userId, filter, now);
  const result = await db.execute({
    sql: `SELECT
            SUM(CASE WHEN EXISTS (SELECT 1 FROM workflow_instances wi
                  JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
                  WHERE wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id
                    AND wsi.status IN ('PENDING','ACTIVE')) THEN 1 ELSE 0 END) AS awaiting_approval,
            SUM(CASE WHEN po.status = 'APPROVED' AND po.physical_received_at IS NULL THEN 1 ELSE 0 END) AS awaiting_receipt,
            SUM(CASE WHEN po.physical_received_at IS NOT NULL AND po.oracle_stock_posted_at IS NULL
                 THEN 1 ELSE 0 END) AS awaiting_posting,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM sla_instances si
                  WHERE si.entity_type = 'PURCHASE_ORDER' AND si.entity_id = po.purchase_order_id
                    AND si.status = 'RUNNING' AND si.warning_at IS NOT NULL
                    AND si.warning_at <= ? AND si.target_at > ?) THEN 1 ELSE 0 END) AS at_risk,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM sla_instances si
                  WHERE si.entity_type = 'PURCHASE_ORDER' AND si.entity_id = po.purchase_order_id
                    AND si.status = 'BREACHED') THEN 1 ELSE 0 END) AS breached
          FROM ${population.source} WHERE ${population.where}`,
    args: [now, now, ...population.args] as never[],
  });
  const row = (result.rows[0] ?? {}) as unknown as Record<string, unknown>;
  return [
    {
      key: 'awaiting_approval',
      label: 'Awaiting approval',
      orders: Number(row.awaiting_approval ?? 0),
      drill: { stageState: 'PENDING' },
    },
    {
      key: 'awaiting_receipt',
      label: 'Awaiting physical receipt',
      orders: Number(row.awaiting_receipt ?? 0),
      drill: { status: 'APPROVED' },
    },
    {
      key: 'awaiting_posting',
      label: 'Awaiting Oracle posting',
      orders: Number(row.awaiting_posting ?? 0),
      drill: { status: 'RECEIVED' },
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

// ---- Approver performance, by stage and by authority context -----------------

export interface PoApproverRow {
  userId: string | null;
  approver: string;
  affiliateId: string | null;
  affiliateName: string | null;
  stageCode: string;
  stageName: string;
  sequenceNo: number;
  /**
   * COUNTRY where every transaction sits in one affiliate, GROUP where the
   * person approves across more than one. A Group approver's figures are
   * never quietly filed under whichever country appears first.
   */
  authorityContext: 'COUNTRY' | 'GROUP';
  affiliatesCovered: number;
  transactions: number;
  medianMinutes: number | null;
  averageMinutes: number | null;
  p90Minutes: number | null;
  withinSlaPercent: number | null;
  pending: number;
  oldestPendingAt: string | null;
  rankEligible: boolean;
  rank: number | null;
}

/**
 * Approver performance, separated by stage.
 *
 * A person who approves at level two on some orders and level four on others
 * gets two rows. The work is different and one purchase order number for
 * them both would describe neither.
 *
 * The authority context is derived rather than assumed: a person whose
 * transactions span more than one affiliate is marked GROUP, so a Group
 * approver's turnaround is never read as one country's performance. Where
 * the analysis is scoped to a single affiliate the context reads COUNTRY,
 * because within that filter it genuinely is.
 */
export async function approverPerformance(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<{ rows: PoApproverRow[]; minimumVolume: number }> {
  const population = await poPopulation(db, userId, filter, now);
  const result = await db.execute({
    sql: `WITH stages AS (${stageView(population)}),
          measured AS (
            SELECT assigned_user_id, affiliate_id, stage_code, stage_name, sequence_no,
                   stage_status, actionable_at, stage_instance_id,
                   ${minutesBetweenSql('actionable_at', 'completed_at')} AS v
            FROM stages
          ),
          ranked AS (
            SELECT assigned_user_id, stage_code, v,
                   ROW_NUMBER() OVER (PARTITION BY assigned_user_id, stage_code ORDER BY v) AS rn,
                   COUNT(*) OVER (PARTITION BY assigned_user_id, stage_code) AS c
            FROM measured WHERE v IS NOT NULL
          ),
          percentiles AS (
            SELECT assigned_user_id, stage_code,
                   MAX(CASE WHEN rn = (c + 1) / 2 THEN v END) AS median_minutes,
                   MAX(CASE WHEN rn = (c * 9 + 9) / 10 THEN v END) AS p90_minutes
            FROM ranked GROUP BY assigned_user_id, stage_code
          )
          SELECT m.assigned_user_id AS user_id,
                 COALESCE(u.display_name, 'Unassigned') AS approver,
                 MIN(m.affiliate_id) AS affiliate_id,
                 COUNT(DISTINCT m.affiliate_id) AS affiliates_covered,
                 m.stage_code, m.stage_name, m.sequence_no,
                 SUM(CASE WHEN m.v IS NOT NULL THEN 1 ELSE 0 END) AS transactions,
                 AVG(m.v) AS average_minutes,
                 SUM(CASE WHEN m.stage_status IN ('PENDING','ACTIVE') THEN 1 ELSE 0 END) AS pending,
                 MIN(CASE WHEN m.stage_status IN ('PENDING','ACTIVE') THEN m.actionable_at END) AS oldest_pending,
                 SUM(CASE WHEN si.status = 'MET' THEN 1 ELSE 0 END) AS met,
                 SUM(CASE WHEN si.status = 'BREACHED' THEN 1 ELSE 0 END) AS breached,
                 (SELECT median_minutes FROM percentiles p
                   WHERE p.assigned_user_id IS m.assigned_user_id AND p.stage_code = m.stage_code) AS median_minutes,
                 (SELECT p90_minutes FROM percentiles p
                   WHERE p.assigned_user_id IS m.assigned_user_id AND p.stage_code = m.stage_code) AS p90_minutes
          FROM measured m
          LEFT JOIN users u ON u.user_id = m.assigned_user_id
          LEFT JOIN sla_instances si ON si.workflow_stage_instance_id = m.stage_instance_id
          GROUP BY m.assigned_user_id, m.stage_code, m.sequence_no
          ORDER BY transactions DESC, approver`,
    args: population.args as never[],
  });

  const affiliateNames = await db.execute(`SELECT affiliate_id, affiliate_name FROM affiliates`);
  const names = new Map(
    affiliateNames.rows.map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      return [text(row.affiliate_id), text(row.affiliate_name)];
    }),
  );

  const rows: PoApproverRow[] = result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const covered = Number(row.affiliates_covered ?? 0);
    const met = Number(row.met ?? 0);
    const breached = Number(row.breached ?? 0);
    const transactions = Number(row.transactions ?? 0);
    const affiliateId = covered === 1 ? nullableText(row.affiliate_id) : null;
    return {
      userId: nullableText(row.user_id),
      approver: text(row.approver),
      affiliateId,
      affiliateName: affiliateId === null ? null : (names.get(affiliateId) ?? null),
      stageCode: text(row.stage_code),
      stageName: text(row.stage_name),
      sequenceNo: Number(row.sequence_no),
      authorityContext: covered > 1 ? 'GROUP' : 'COUNTRY',
      affiliatesCovered: covered,
      transactions,
      medianMinutes: number(row.median_minutes),
      averageMinutes: number(row.average_minutes),
      p90Minutes: number(row.p90_minutes),
      withinSlaPercent: rate(met, met + breached),
      pending: Number(row.pending ?? 0),
      oldestPendingAt: nullableText(row.oldest_pending),
      rankEligible: transactions >= filter.minVolume,
      rank: null,
    };
  });

  const eligible = rows
    .filter((row) => row.rankEligible && row.medianMinutes !== null)
    .sort((a, b) => (a.medianMinutes ?? 0) - (b.medianMinutes ?? 0));
  eligible.forEach((row, index) => {
    row.rank = index + 1;
  });
  return { rows, minimumVolume: filter.minVolume };
}

// ---- What was actually bought ------------------------------------------------

export interface ProcurementRow {
  classification: string;
  /**
   * CATALOGUE where the order has resolved product lines; SOURCE where it
   * has none and the extract's own NATURE value is all that is known.
   */
  basis: 'CATALOGUE' | 'SOURCE' | 'UNCLASSIFIED';
  orders: number;
  note: string;
}

/**
 * What the selected purchase orders were for.
 *
 * NOT EVERY ORDER IS FUEL, and the file proves it. The extract's NATURE
 * column holds PRODUCT, LPG and LUBES, and nine of the 21 rows marked LPG
 * are 2go shop procurement: assorted pastries, soft drinks, dried fruits.
 * So NATURE is reported as the source's own classification and is never
 * mapped into the petroleum catalogue. An order with resolved catalogue
 * lines is grouped by its product group; an order with none is grouped by
 * its source classification and labelled as awaiting a master data
 * decision. Nothing here writes to the catalogue, and general procurement
 * never lands under fuel.
 */
export async function procurementMix(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<ProcurementRow[]> {
  const population = await poPopulation(db, userId, filter, now);
  const [catalogue, source] = await Promise.all([
    db.execute({
      sql: `SELECT pg.group_name AS name, COUNT(DISTINCT po.purchase_order_id) AS orders
            FROM ${population.source}
            JOIN purchase_order_lines pol ON pol.purchase_order_id = po.purchase_order_id
            JOIN products p ON p.product_id = pol.product_id
            JOIN product_categories pc ON pc.product_category_id = p.product_category_id
            JOIN product_groups pg ON pg.product_group_id = pc.product_group_id
            WHERE ${population.where}
            GROUP BY pg.product_group_id ORDER BY orders DESC`,
      args: population.args as never[],
    }),
    db.execute({
      sql: `SELECT COALESCE(json_extract(rs.snapshot_json, '$.nature'), 'Not stated') AS nature,
                   COUNT(*) AS orders
            FROM ${population.source}
            LEFT JOIN record_snapshots rs
              ON rs.entity_type = 'PURCHASE_ORDER' AND rs.entity_id = po.purchase_order_id
             AND rs.is_current = 1
            WHERE ${population.where}
              AND NOT EXISTS (SELECT 1 FROM purchase_order_lines pol
                              WHERE pol.purchase_order_id = po.purchase_order_id)
            GROUP BY nature ORDER BY orders DESC`,
      args: population.args as never[],
    }),
  ]);

  const rows: ProcurementRow[] = catalogue.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      classification: text(row.name),
      basis: 'CATALOGUE',
      orders: Number(row.orders ?? 0),
      note: 'Grouped by the product catalogue, from resolved order lines.',
    };
  });
  for (const raw of source.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const nature = text(row.nature);
    rows.push({
      classification: `Source classification: ${nature}`,
      basis: nature === 'Not stated' ? 'UNCLASSIFIED' : 'SOURCE',
      orders: Number(row.orders ?? 0),
      note:
        nature === 'Not stated'
          ? 'No catalogue line and no source classification. Awaiting a master data decision.'
          : `The extract's own NATURE value. It is NOT a catalogue mapping: the ${nature} bucket in this source includes general procurement such as shop stock, so nothing here is filed under a petroleum product.`,
    });
  }
  return rows;
}

// ---- Trend -------------------------------------------------------------------

export interface PoTrendBucket {
  bucket: string;
  orders: number;
  approvalCycleMedianMinutes: number | null;
  receiptToPostingMedianMinutes: number | null;
  slaCompliancePercent: number | null;
  pending: number;
}

export async function trend(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<PoTrendBucket[]> {
  const population = await poPopulation(db, userId, filter, now);
  const bucket = bucketExpression('po.po_created_at', filter.grain);
  const finalApproval = `(SELECT MAX(wsi.completed_at) FROM workflow_instances wi
      JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
      WHERE wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id)`;
  const result = await db.execute({
    sql: `WITH base AS (
            SELECT ${bucket} AS bucket,
                   ${minutesBetweenSql('po.submitted_for_approval_at', finalApproval)} AS cycle,
                   ${minutesBetweenSql('po.physical_received_at', 'po.oracle_stock_posted_at')} AS posting,
                   CASE WHEN EXISTS (SELECT 1 FROM workflow_instances wi
                          JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
                          WHERE wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = po.purchase_order_id
                            AND wsi.status IN ('PENDING','ACTIVE')) THEN 1 ELSE 0 END AS is_pending,
                   (SELECT si.status FROM sla_instances si
                     WHERE si.entity_type = 'PURCHASE_ORDER' AND si.entity_id = po.purchase_order_id
                     ORDER BY CASE si.status WHEN 'BREACHED' THEN 0 WHEN 'MET' THEN 1 ELSE 2 END
                     LIMIT 1) AS sla_status
            FROM ${population.source} WHERE ${population.where}
          ),
          ranked AS (
            SELECT bucket, cycle, posting, is_pending, sla_status,
            -- NULLS SORT LAST, AND THE MEDIAN DEPENDS ON IT. One ranked CTE
            -- serves several columns, so it cannot filter the nulls out the
            -- way a single-metric query does. The count counts only values
            -- that exist, so the median sits at row (c + 1) / 2 among them;
            -- SQLite sorts NULL first by default, which would put that row
            -- number inside the missing values and report Not available for
            -- a period that has perfectly good figures in it.
              ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY (cycle IS NULL), cycle) AS cycle_rn,
              COUNT(cycle) OVER (PARTITION BY bucket) AS cycle_c,
              ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY (posting IS NULL), posting) AS posting_rn,
              COUNT(posting) OVER (PARTITION BY bucket) AS posting_c
            FROM base
          )
          SELECT bucket, COUNT(*) AS orders,
                 MAX(CASE WHEN cycle_rn = (cycle_c + 1) / 2 THEN cycle END) AS cycle_median,
                 MAX(CASE WHEN posting_rn = (posting_c + 1) / 2 THEN posting END) AS posting_median,
                 SUM(is_pending) AS pending,
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
      approvalCycleMedianMinutes: number(row.cycle_median),
      receiptToPostingMedianMinutes: number(row.posting_median),
      slaCompliancePercent: rate(met, met + breached),
      pending: Number(row.pending ?? 0),
    };
  });
}

// ---- The stock constraint view -----------------------------------------------

export interface StockConstraintRow {
  productId: string;
  productCode: string;
  affiliateId: string;
  affiliateName: string;
  /** Sales orders for this product and entity in the period, not yet loaded. */
  openSalesOrders: number;
  /** Purchase orders for the same product and entity, not yet posted to Oracle. */
  purchaseOrdersAwaitingPosting: number;
  oldestOpenSalesOrderAt: string | null;
  oldestUnpostedPurchaseOrderAt: string | null;
}

/**
 * Where sales demand and unposted stock coincide.
 *
 * READ THIS BEFORE READING THE TABLE.
 * There is no relationship in this schema between a sales order and a
 * purchase order. None. This view does not claim one. It correlates on the
 * product and the entity over the same period and says only that, in that
 * product and that entity, there were open sales orders at the same time as
 * purchase orders whose stock had not been posted.
 *
 * That is a coincidence worth a manager's attention and nothing more. It is
 * not evidence that the sales order is waiting for that purchase order, and
 * the wording in the interface says "potentially stock-constrained" for
 * exactly that reason. Correlation is not causation, and a dashboard that
 * blurs the two teaches people to act on a fiction.
 */
export const STOCK_CONSTRAINT_WORDING =
  'Potentially stock-constrained. This schema holds no link between a sales order and a purchase order, so these rows are a correlation on product and entity within the same period and nothing more. No sales order here is known to be waiting for any purchase order.';

export async function stockConstraint(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<{ rows: StockConstraintRow[]; wording: string }> {
  const poPop = await poPopulation(db, userId, filter, now);
  // The sales side is read under its own scope predicate, so a reader sees
  // demand only where they may see the orders themselves.
  const salesScope = await resolveScope(db, userId, SALES_ORDER_VIEW);
  const salesPredicate = salesScope.granted
    ? scopePredicate(salesScope, {
        country: 'af.country_id',
        affiliate: 'so.affiliate_id',
        businessUnit: 'so.business_unit_id',
      })
    : DENY_ALL;
  const window = dateWindow('so.order_created_at', filter);

  const result = await db.execute({
    sql: `WITH demand AS (
            SELECT p.product_id, p.product_code, so.affiliate_id,
                   COUNT(DISTINCT so.sales_order_id) AS open_orders,
                   MIN(so.order_created_at) AS oldest
            FROM sales_orders so
            JOIN affiliates af ON af.affiliate_id = so.affiliate_id
            JOIN sales_order_lines sol ON sol.sales_order_id = so.sales_order_id
            JOIN products p ON p.product_id = sol.product_id
            WHERE ${salesPredicate.sql} AND ${window.sql}
              AND so.status NOT IN ('LOADED','CANCELLED')
            GROUP BY p.product_id, so.affiliate_id
          ),
          unposted AS (
            SELECT p.product_id, po.affiliate_id,
                   COUNT(DISTINCT po.purchase_order_id) AS awaiting,
                   MIN(po.po_created_at) AS oldest
            FROM ${poPop.source}
            JOIN purchase_order_lines pol ON pol.purchase_order_id = po.purchase_order_id
            JOIN products p ON p.product_id = pol.product_id
            WHERE ${poPop.where} AND po.oracle_stock_posted_at IS NULL
            GROUP BY p.product_id, po.affiliate_id
          )
          SELECT d.product_id, d.product_code, d.affiliate_id, af.affiliate_name,
                 d.open_orders, u.awaiting, d.oldest AS oldest_sales, u.oldest AS oldest_purchase
          FROM demand d
          JOIN unposted u ON u.product_id = d.product_id AND u.affiliate_id = d.affiliate_id
          JOIN affiliates af ON af.affiliate_id = d.affiliate_id
          ORDER BY d.open_orders DESC`,
    args: [
      ...(salesPredicate.args as (string | number)[]),
      ...window.args,
      ...poPop.args,
    ] as never[],
  });
  return {
    wording: STOCK_CONSTRAINT_WORDING,
    rows: result.rows.map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      return {
        productId: text(row.product_id),
        productCode: text(row.product_code),
        affiliateId: text(row.affiliate_id),
        affiliateName: text(row.affiliate_name),
        openSalesOrders: Number(row.open_orders ?? 0),
        purchaseOrdersAwaitingPosting: Number(row.awaiting ?? 0),
        oldestOpenSalesOrderAt: nullableText(row.oldest_sales),
        oldestUnpostedPurchaseOrderAt: nullableText(row.oldest_purchase),
      };
    }),
  };
}

// ---- One purchase order ------------------------------------------------------

export interface PoStage {
  stageInstanceId: string;
  stageCode: string;
  stageName: string;
  sequenceNo: number;
  status: string;
  approver: string | null;
  actionableAt: string | null;
  completedAt: string | null;
  elapsedMinutes: number | null;
  /** Set while the stage is still open, so a pending stage ages visibly. */
  pendingMinutes: number | null;
  slaStatus: string | null;
}

export interface PurchaseOrderDetail {
  order: PurchaseOrderRow;
  lines: {
    lineNumber: number;
    productCode: string | null;
    productName: string | null;
    quantity: number | null;
    unitCost: number | null;
    lineValue: number | null;
    unitOfMeasure: string | null;
  }[];
  stages: PoStage[];
  durations: {
    creationToSubmissionMinutes: number | null;
    approvalCycleMinutes: number | null;
    approvalToPhysicalReceiptMinutes: number | null;
    physicalReceiptToOraclePostingMinutes: number | null;
  };
  /** True only where the cycle genuinely finished; a pending order has none. */
  cycleComplete: boolean;
  snapshots: { versionNo: number; capturedAt: string; isCurrent: boolean; snapshotJson: string }[];
}

export async function purchaseOrderDetail(
  db: Client,
  userId: string,
  purchaseOrderId: string,
  now: string,
): Promise<PurchaseOrderDetail | null> {
  const scope = await scopedPurchaseOrders(db, userId);
  const found = await db.execute({
    sql: `SELECT po.purchase_order_id AS id, po.document_number AS doc,
            po.affiliate_id AS affiliate_id, af.affiliate_name AS affiliate,
            bu.business_unit_name AS business_unit, po.supplier_name AS supplier,
            po.po_created_at AS created, po.submitted_for_approval_at AS submitted,
            po.status AS status, po.physical_received_at AS received,
            po.oracle_stock_posted_at AS posted, po.currency_code AS currency, po.po_value AS value
          FROM ${PO_SOURCE}
          WHERE po.purchase_order_id = ? AND ${scope.sql} LIMIT 1`,
    args: [purchaseOrderId, ...scope.args] as never[],
  });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;

  const [lines, stageRows, snapshots] = await Promise.all([
    db.execute({
      sql: `SELECT pol.line_number, p.product_code, p.product_name, p.unit_of_measure,
              pol.quantity, pol.unit_cost, pol.line_value
            FROM purchase_order_lines pol
            LEFT JOIN products p ON p.product_id = pol.product_id
            WHERE pol.purchase_order_id = ? ORDER BY pol.line_number`,
      args: [purchaseOrderId],
    }),
    db.execute({
      sql: `WITH stages AS (
              SELECT wsi.workflow_stage_instance_id AS id, ws.stage_code, ws.stage_name,
                     ws.sequence_no, wsi.status, u.display_name AS approver,
                     wsi.completed_at,
                     COALESCE(
                       wsi.started_at, wsi.assigned_at,
                       CASE WHEN ws.sequence_no = MIN(ws.sequence_no) OVER (PARTITION BY wi.workflow_instance_id)
                            THEN (SELECT submitted_for_approval_at FROM purchase_orders
                                   WHERE purchase_order_id = wi.entity_id)
                            ELSE LAG(wsi.completed_at) OVER (
                                   PARTITION BY wi.workflow_instance_id ORDER BY ws.sequence_no)
                       END
                     ) AS actionable_at,
                     si.status AS sla_status
              FROM workflow_instances wi
              JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
              JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
              LEFT JOIN users u ON u.user_id = wsi.assigned_user_id
              LEFT JOIN sla_instances si ON si.workflow_stage_instance_id = wsi.workflow_stage_instance_id
              WHERE wi.entity_type = 'PURCHASE_ORDER' AND wi.entity_id = ?
            )
            SELECT *, ${minutesBetweenSql('actionable_at', 'completed_at')} AS elapsed,
                   CASE WHEN completed_at IS NULL
                        THEN ${minutesBetweenSql('actionable_at', '?')} END AS pending_minutes
            FROM stages ORDER BY sequence_no`,
      args: [purchaseOrderId, now, now],
    }),
    db.execute({
      sql: `SELECT version_no, captured_at, is_current, snapshot_json FROM record_snapshots
            WHERE entity_type = 'PURCHASE_ORDER' AND entity_id = ? ORDER BY version_no DESC`,
      args: [purchaseOrderId],
    }),
  ]);

  const stages: PoStage[] = stageRows.rows.map((raw) => {
    const record = raw as unknown as Record<string, unknown>;
    return {
      stageInstanceId: text(record.id),
      stageCode: text(record.stage_code),
      stageName: text(record.stage_name),
      sequenceNo: Number(record.sequence_no),
      status: text(record.status),
      approver: nullableText(record.approver),
      actionableAt: nullableText(record.actionable_at),
      completedAt: nullableText(record.completed_at),
      elapsedMinutes: number(record.elapsed),
      pendingMinutes: number(record.pending_minutes),
      slaStatus: nullableText(record.sla_status),
    };
  });

  const submitted = nullableText(row.submitted);
  const received = nullableText(row.received);
  const posted = nullableText(row.posted);
  const finalApproval =
    stages.length === 0
      ? null
      : stages.reduce<string | null>(
          (latest, stage) =>
            stage.completedAt !== null && (latest === null || stage.completedAt > latest)
              ? stage.completedAt
              : latest,
          null,
        );
  const cycleComplete = stages.length > 0 && stages.every((stage) => stage.completedAt !== null);
  const between = (from: string | null, to: string | null) =>
    from === null || to === null
      ? null
      : Math.round(
          (Date.parse(`${to.replace(' ', 'T')}Z`) - Date.parse(`${from.replace(' ', 'T')}Z`)) /
            60000,
        );

  return {
    order: {
      purchaseOrderId: text(row.id),
      documentNumber: text(row.doc),
      affiliateId: text(row.affiliate_id),
      affiliateName: text(row.affiliate),
      businessUnitName: nullableText(row.business_unit),
      supplierName: nullableText(row.supplier),
      productSummary: null,
      poCreatedAt: text(row.created),
      submittedForApprovalAt: submitted,
      currentStage: stages.find((stage) => stage.completedAt === null)?.stageName ?? null,
      currentApprover: stages.find((stage) => stage.completedAt === null)?.approver ?? null,
      status: text(row.status),
      physicalReceivedAt: received,
      oracleStockPostedAt: posted,
      awaitingOraclePosting: received !== null && posted === null,
      slaStatus: null,
      currencyCode: nullableText(row.currency),
      poValue: number(row.value),
      approvalStagesRecorded: stages.length,
    },
    lines: lines.rows.map((raw) => {
      const record = raw as unknown as Record<string, unknown>;
      return {
        lineNumber: Number(record.line_number),
        productCode: nullableText(record.product_code),
        productName: nullableText(record.product_name),
        quantity: number(record.quantity),
        unitCost: number(record.unit_cost),
        lineValue: number(record.line_value),
        unitOfMeasure: nullableText(record.unit_of_measure),
      };
    }),
    stages,
    durations: {
      creationToSubmissionMinutes: between(text(row.created), submitted),
      // The cycle exists only where every recorded stage finished. A pending
      // order reports nothing here and ages in the backlog instead.
      approvalCycleMinutes: cycleComplete ? between(submitted, finalApproval) : null,
      approvalToPhysicalReceiptMinutes: between(finalApproval, received),
      physicalReceiptToOraclePostingMinutes: between(received, posted),
    },
    cycleComplete,
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
