/**
 * The SLA section's approval view: who has to say yes, and how long it takes.
 *
 * THE PRIMARY CUT IS THE APPROVAL FUNCTION, NOT THE AFFILIATE.
 * Finance approval, credit release, the country manager's sign-off: those are
 * the things a manager can act on. "Kenya" is not something anybody approves.
 * Affiliate is therefore a filter at the top of the section, applied to
 * everything below it, and it is the axis of nothing. Two facts force it:
 * purchase orders have no affiliate column in the extract at all (the value on
 * the row is the affiliate chosen on the Upload Centre form, which is a
 * property of the upload and not of the order), and sales orders carry one
 * today but will carry several, which a chart keyed on it would not survive.
 *
 * THERE IS NO BUSINESS UNIT CUT, DELIBERATELY.
 * Neither extract carries one populated well enough to chart, and an empty
 * chart is worse than no chart. When the extract grows one, this file is where
 * it goes; until then nothing here pretends to have it.
 *
 * THE FUNCTIONS COME FROM THE SCHEMA, NEVER FROM A LIST IN THIS FILE.
 * Every function below is a `workflow_stages` row that the selected orders
 * actually used, named by the `workflow_roles` row it is assigned to where it
 * has one. Three purchase order levels today and seven next quarter is a
 * configuration change and no code change: a level nobody used has no row
 * here, and a level somebody added appears the moment an order passes through
 * it.
 *
 * THE TARGET IS PER FUNCTION AND ONLY WHERE ONE IS CONFIGURED.
 * It comes from the `sla_rules` row the stage points at, and it is reported
 * only where every workflow definition contributing to that function agrees on
 * the number. Two countries holding finance approval to different targets do
 * not have "a target", and drawing one would measure one of them against a
 * number nobody set for it.
 */
import type { Client } from '@libsql/client/web';
import { soPopulation } from '../repos/soPerformance.ts';
import {
  poPopulation,
  STAGE_VIEW,
  trend as poTrend,
  type PoTrendBucket,
} from '../repos/poPerformance.ts';
import { rate } from '../analytics/stats.ts';
import type { AnalyticsFilter } from '../analytics/filters.ts';

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const number = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export type ProcessType = 'SALES_ORDER' | 'PURCHASE_ORDER';

/**
 * THE AFFILIATE FILTER IS THE PAGE FILTER, ON PURPOSE.
 *
 * It is rendered at the top of the SLA section, and it writes `affiliateId`,
 * which every section on the dashboard already reads. A second, section-only
 * affiliate parameter was the alternative and it is worse: two affiliate
 * controls on one page can be set to different affiliates, and then the SLA
 * figures and the Orders figures beneath them describe different companies
 * while both look authoritative. One control, one meaning, everything below it
 * moves together.
 */

export interface ApprovalFunction {
  processType: ProcessType;
  /** The stage code, which is what a drill-through carries. */
  stageCode: string;
  /** The workflow role's name where the stage has one, else the stage's own. */
  functionName: string;
  sequenceNo: number;
  /** Completed stage instances with both timestamps. The median's denominator. */
  measured: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
  pending: number;
  oldestPendingAt: string | null;
  /** Only where every contributing definition agrees. See the file header. */
  targetMinutes: number | null;
}

/**
 * The stage aggregate, written once and pointed at either process.
 *
 * The two processes differ in exactly one place: where a stage became
 * answerable. A purchase order's first stage is measured from
 * `submitted_for_approval_at`, never from creation, so the caller passes the
 * view that knows it. Everything after that is the same arithmetic and there
 * is no reason for two copies of it to drift apart.
 */
function functionSql(stagesCte: string): string {
  return `WITH stages AS (${stagesCte}),
    measured AS (
      SELECT stage_code,
             CASE WHEN actionable_at IS NULL OR completed_at IS NULL THEN NULL
                  ELSE (julianday(completed_at) - julianday(actionable_at)) * 1440.0 END AS v
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
    SELECT s.stage_code AS stage_code,
           MIN(s.stage_name) AS stage_name,
           MIN(s.sequence_no) AS sequence_no,
           CASE WHEN COUNT(DISTINCT wr.role_name) = 1 AND COUNT(s.role_id) = COUNT(*)
                THEN MIN(wr.role_name) END AS role_name,
           CASE WHEN COUNT(DISTINCT r.target_minutes) = 1 AND COUNT(r.target_minutes) = COUNT(*)
                THEN MIN(r.target_minutes) END AS target_minutes,
           SUM(CASE WHEN s.actionable_at IS NOT NULL AND s.completed_at IS NOT NULL
                    THEN 1 ELSE 0 END) AS measured,
           SUM(CASE WHEN s.stage_status IN ('PENDING','ACTIVE') THEN 1 ELSE 0 END) AS pending,
           MIN(CASE WHEN s.stage_status IN ('PENDING','ACTIVE') THEN s.actionable_at END) AS oldest_pending,
           (SELECT median_minutes FROM percentiles p WHERE p.stage_code = s.stage_code) AS median_minutes,
           (SELECT p90_minutes FROM percentiles p WHERE p.stage_code = s.stage_code) AS p90_minutes
    FROM stages s
    LEFT JOIN workflow_roles wr ON wr.workflow_role_id = s.role_id
    LEFT JOIN sla_rules r ON r.sla_rule_id = s.rule_id AND r.active = 1
    GROUP BY s.stage_code
    ORDER BY sequence_no, s.stage_code`;
}

/**
 * The sales order stage view.
 *
 * `actionable_at` is the persisted moment the stage opened, falling back to
 * when it was assigned. There is no positional fallback here as there is for
 * purchase orders, because a sales order carries no submission timestamp to
 * start the first stage from and guessing one would invent the figure this
 * chart exists to report.
 */
function soStagesCte(source: string, where: string): string {
  return `SELECT ws.stage_code AS stage_code,
                 ws.stage_name AS stage_name,
                 ws.sequence_no AS sequence_no,
                 ws.assigned_workflow_role_id AS role_id,
                 ws.sla_rule_id AS rule_id,
                 wsi.status AS stage_status,
                 wsi.assigned_user_id AS assigned_user_id,
                 wsi.workflow_stage_instance_id AS stage_instance_id,
                 COALESCE(wsi.started_at, wsi.assigned_at) AS actionable_at,
                 wsi.completed_at AS completed_at
          FROM ${source}
          JOIN workflow_instances wi
            ON wi.entity_type = 'SALES_ORDER' AND wi.entity_id = so.sales_order_id
          JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
          JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
          WHERE ${where}`;
}

/**
 * The purchase order stage view, with the two columns the function chart needs
 * added to the one the purchase order page already uses.
 *
 * It is built from the exported view rather than rewritten, so `actionable_at`
 * carries exactly the meaning the purchase order performance page gives it and
 * the two pages cannot disagree about what stage one is measured from.
 */
function poStagesCte(source: string, where: string): string {
  return STAGE_VIEW.replace('{SOURCE}', source)
    .replace('{WHERE}', where)
    .replace(
      '         ws.stage_code AS stage_code,',
      '         ws.assigned_workflow_role_id AS role_id,\n' +
        '         ws.sla_rule_id AS rule_id,\n' +
        '         ws.stage_code AS stage_code,',
    );
}

function readFunctions(
  rows: readonly unknown[],
  processType: ProcessType,
): ApprovalFunction[] {
  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      processType,
      stageCode: text(row.stage_code),
      functionName: nullableText(row.role_name) ?? text(row.stage_name),
      sequenceNo: Number(row.sequence_no ?? 0),
      measured: Number(row.measured ?? 0),
      medianMinutes: number(row.median_minutes),
      p90Minutes: number(row.p90_minutes),
      pending: Number(row.pending ?? 0),
      oldestPendingAt: nullableText(row.oldest_pending),
      targetMinutes: number(row.target_minutes),
    };
  });
}

export interface ApproverStanding {
  processType: ProcessType;
  stageCode: string;
  functionName: string;
  sequenceNo: number;
  userId: string | null;
  approver: string;
  transactions: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
  withinSlaPercent: number | null;
  pending: number;
  oldestPendingAt: string | null;
  rankEligible: boolean;
  /** 1-based WITHIN THE FUNCTION, or null below the minimum volume. */
  rank: number | null;
}

/**
 * The leaderboard aggregate: one person, one function, one row.
 *
 * The grouping key is the person and the stage, and it is NOT the affiliate.
 * The affiliate is already in the population predicate above, so a reader
 * looking at Kenya sees each Kenyan approver once. Grouping by it as well
 * would split one person's finance approvals into a row per country and rank
 * the halves against each other, which describes nobody.
 *
 * A person who approves at two different functions gets two rows and is never
 * blended into a single average, because a credit release and an invoicing
 * sign-off are different work and one median across them measures neither.
 */
function standingSql(stagesCte: string): string {
  return `WITH stages AS (${stagesCte}),
    measured AS (
      SELECT assigned_user_id, stage_code, stage_name, sequence_no, role_id,
             stage_status, actionable_at, stage_instance_id,
             CASE WHEN actionable_at IS NULL OR completed_at IS NULL THEN NULL
                  ELSE (julianday(completed_at) - julianday(actionable_at)) * 1440.0 END AS v
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
           m.stage_code AS stage_code,
           MIN(m.stage_name) AS stage_name,
           MIN(m.sequence_no) AS sequence_no,
           CASE WHEN COUNT(DISTINCT wr.role_name) = 1 AND COUNT(m.role_id) = COUNT(*)
                THEN MIN(wr.role_name) END AS role_name,
           SUM(CASE WHEN m.v IS NOT NULL THEN 1 ELSE 0 END) AS transactions,
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
    LEFT JOIN workflow_roles wr ON wr.workflow_role_id = m.role_id
    LEFT JOIN sla_instances si ON si.workflow_stage_instance_id = m.stage_instance_id
    GROUP BY m.assigned_user_id, m.stage_code
    ORDER BY sequence_no, transactions DESC, approver`;
}

function readStandings(
  rows: readonly unknown[],
  processType: ProcessType,
  minimumVolume: number,
): ApproverStanding[] {
  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const met = Number(row.met ?? 0);
    const breached = Number(row.breached ?? 0);
    const transactions = Number(row.transactions ?? 0);
    return {
      processType,
      stageCode: text(row.stage_code),
      functionName: nullableText(row.role_name) ?? text(row.stage_name),
      sequenceNo: Number(row.sequence_no ?? 0),
      userId: nullableText(row.user_id),
      approver: text(row.approver),
      transactions,
      medianMinutes: number(row.median_minutes),
      p90Minutes: number(row.p90_minutes),
      withinSlaPercent: rate(met, met + breached),
      pending: Number(row.pending ?? 0),
      oldestPendingAt: nullableText(row.oldest_pending),
      rankEligible: transactions >= minimumVolume,
      rank: null,
    };
  });
}

export interface ApprovalGroup {
  processType: ProcessType;
  stageCode: string;
  functionName: string;
  sequenceNo: number;
  rows: ApproverStanding[];
}

/**
 * Rank WITHIN the function, never across the section.
 *
 * A single ranking down the whole list would put the fastest invoicing clerk
 * above the slowest credit approver and call it a league table, when the two
 * are not doing the same job. Within a function the comparison is between
 * people who face the same queue, which is the only comparison that means
 * anything. Below the minimum volume there is no rank at all and the row still
 * shows its figures.
 */
function group(rows: ApproverStanding[]): ApprovalGroup[] {
  const groups = new Map<string, ApprovalGroup>();
  for (const row of rows) {
    const key = `${row.processType}|${row.stageCode}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        processType: row.processType,
        stageCode: row.stageCode,
        functionName: row.functionName,
        sequenceNo: row.sequenceNo,
        rows: [row],
      });
    } else {
      existing.rows.push(row);
    }
  }
  for (const one of groups.values()) {
    const eligible = one.rows
      .filter((row) => row.rankEligible && row.medianMinutes !== null)
      .sort((a, b) => (a.medianMinutes ?? 0) - (b.medianMinutes ?? 0));
    eligible.forEach((row, index) => {
      row.rank = index + 1;
    });
    one.rows.sort((a, b) => b.transactions - a.transactions || a.approver.localeCompare(b.approver));
  }
  // Sales orders first, then purchase orders, each in workflow sequence. The
  // order is the order the work happens in, not alphabetical: reading down the
  // section should walk the process.
  const order = (processType: ProcessType) => (processType === 'SALES_ORDER' ? 0 : 1);
  return [...groups.values()].sort(
    (a, b) =>
      order(a.processType) - order(b.processType) ||
      a.sequenceNo - b.sequenceNo ||
      a.functionName.localeCompare(b.functionName),
  );
}

export interface ProductGroupTurnaround {
  productGroupId: string;
  productGroupName: string;
  orders: number;
  medianMinutes: number | null;
}

/**
 * Median stage one turnaround, by product group.
 *
 * The first stage is the one this purchase order actually started at, read per
 * order rather than assumed to be sequence one, because a definition that
 * begins at level two is still that order's first stage.
 *
 * AN ORDER WITH LINES IN TWO GROUPS COUNTS IN BOTH, ONCE EACH. Apportioning a
 * single turnaround between the groups would invent a split the data does not
 * carry, and dropping the order would lose it entirely. The definition on the
 * chart says so, so the column totals are not read as an order count.
 */
function stageOneByProductGroupSql(source: string, where: string): string {
  return `WITH stages AS (${STAGE_VIEW.replace('{SOURCE}', source).replace('{WHERE}', where)}),
    first_stage AS (
      SELECT s.purchase_order_id, s.actionable_at, s.completed_at
      FROM stages s
      WHERE s.sequence_no = (SELECT MIN(s2.sequence_no) FROM stages s2
                              WHERE s2.purchase_order_id = s.purchase_order_id)
    ),
    per_order AS (
      SELECT DISTINCT pg.product_group_id AS gid, pg.group_name AS gname,
             f.purchase_order_id AS oid,
             (julianday(f.completed_at) - julianday(f.actionable_at)) * 1440.0 AS v
      FROM first_stage f
      JOIN purchase_order_lines pol ON pol.purchase_order_id = f.purchase_order_id
      JOIN products p ON p.product_id = pol.product_id
      JOIN product_categories pc ON pc.product_category_id = p.product_category_id
      JOIN product_groups pg ON pg.product_group_id = pc.product_group_id
      WHERE f.actionable_at IS NOT NULL AND f.completed_at IS NOT NULL
    ),
    ranked AS (
      SELECT gid, gname, v,
             ROW_NUMBER() OVER (PARTITION BY gid ORDER BY v) AS rn,
             COUNT(*) OVER (PARTITION BY gid) AS c
      FROM per_order
    )
    SELECT gid, MIN(gname) AS gname, MAX(c) AS orders,
           MAX(CASE WHEN rn = (c + 1) / 2 THEN v END) AS median_minutes
    FROM ranked GROUP BY gid ORDER BY median_minutes DESC, gname`;
}

export interface ApprovalsView {
  /** The affiliate the section is narrowed to, or null for every one in scope. */
  affiliateId: string | null;
  functions: ApprovalFunction[];
  groups: ApprovalGroup[];
  minimumVolume: number;
  /**
   * The purchase order approval cycle by period. The sales order trend is NOT
   * here: the page already holds it for its Orders section, and fetching the
   * same numbers twice on one render is how a budget goes.
   */
  purchaseTrend: { bucket: string; medianMinutes: number | null }[];
  stageOneByProductGroup: ProductGroupTurnaround[];
  /**
   * The credit release, by the person who released it.
   *
   * HOLD_RELEASED_BY in the extract is a person, and the importer resolves it
   * to the credit stage's actor through `source_identities`, so this is that
   * column read back rather than a second interpretation of it. It is derived
   * from the standings already loaded and costs nothing.
   */
  creditRelease: ApproverStanding[];
}

/** The stage code the credit decision is recorded against. */
const CREDIT_STAGE = 'CREDIT_CHECK';

/**
 * Load the section.
 *
 * Both processes are issued together so the batcher folds them into one round
 * trip: this section is four statements, not four requests. The sales order
 * trend is NOT fetched here, because the page already holds it for its Orders
 * section and fetching it twice would be paying twice for the same numbers.
 */
export async function approvals(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
  options: { salesOrders: boolean; purchaseOrders: boolean },
): Promise<ApprovalsView> {
  const soPop = options.salesOrders ? await soPopulation(db, userId, filter, now) : null;
  const poPop = options.purchaseOrders ? await poPopulation(db, userId, filter, now) : null;

  const [soFunctions, poFunctions, soStandings, poStandings, groupRows, purchaseTrend] =
    await Promise.all([
      soPop === null
        ? null
        : db.execute({
            sql: functionSql(soStagesCte(soPop.source, soPop.where)),
            args: soPop.args as never[],
          }),
      poPop === null
        ? null
        : db.execute({
            sql: functionSql(poStagesCte(poPop.source, poPop.where)),
            args: poPop.args as never[],
          }),
      soPop === null
        ? null
        : db.execute({
            sql: standingSql(soStagesCte(soPop.source, soPop.where)),
            args: soPop.args as never[],
          }),
      poPop === null
        ? null
        : db.execute({
            sql: standingSql(poStagesCte(poPop.source, poPop.where)),
            args: poPop.args as never[],
          }),
      poPop === null
        ? null
        : db.execute({
            sql: stageOneByProductGroupSql(poPop.source, poPop.where),
            args: poPop.args as never[],
          }),
      options.purchaseOrders ? poTrend(db, userId, filter, now) : null,
    ]);

  const functions = [
    ...(soFunctions === null ? [] : readFunctions(soFunctions.rows, 'SALES_ORDER')),
    ...(poFunctions === null ? [] : readFunctions(poFunctions.rows, 'PURCHASE_ORDER')),
  ];
  const standings = [
    ...(soStandings === null ? [] : readStandings(soStandings.rows, 'SALES_ORDER', filter.minVolume)),
    ...(poStandings === null
      ? []
      : readStandings(poStandings.rows, 'PURCHASE_ORDER', filter.minVolume)),
  ];

  return {
    affiliateId: filter.affiliateId,
    functions,
    groups: group(standings),
    minimumVolume: filter.minVolume,
    purchaseTrend: ((purchaseTrend ?? []) as PoTrendBucket[]).map((row) => ({
      bucket: row.bucket,
      medianMinutes: row.approvalCycleMedianMinutes,
    })),
    stageOneByProductGroup:
      groupRows === null
        ? []
        : groupRows.rows.map((raw) => {
            const row = raw as unknown as Record<string, unknown>;
            return {
              productGroupId: text(row.gid),
              productGroupName: text(row.gname),
              orders: Number(row.orders ?? 0),
              medianMinutes: number(row.median_minutes),
            };
          }),
    creditRelease: standings
      .filter((row) => row.processType === 'SALES_ORDER' && row.stageCode === CREDIT_STAGE)
      .sort((a, b) => (a.medianMinutes ?? Infinity) - (b.medianMinutes ?? Infinity)),
  };
}

/**
 * Two trends drawn on one pair of axes need the same buckets, and the two
 * processes do not necessarily have orders in the same periods. The union is
 * taken and a period a process had nothing in is null rather than zero: zero
 * minutes is a claim that approvals were instant, and no orders is not that.
 */
export function alignBuckets(
  a: { bucket: string; medianMinutes: number | null }[],
  b: { bucket: string; medianMinutes: number | null }[],
): {
  buckets: string[];
  first: (number | null)[];
  second: (number | null)[];
} {
  const buckets = [...new Set([...a.map((r) => r.bucket), ...b.map((r) => r.bucket)])].sort();
  const index = (rows: { bucket: string; medianMinutes: number | null }[]) =>
    new Map(rows.map((row) => [row.bucket, row.medianMinutes]));
  const first = index(a);
  const second = index(b);
  return {
    buckets,
    first: buckets.map((bucket) => first.get(bucket) ?? null),
    second: buckets.map((bucket) => second.get(bucket) ?? null),
  };
}
