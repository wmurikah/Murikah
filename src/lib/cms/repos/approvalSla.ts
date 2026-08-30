/**
 * Where time is being lost right now: approval turnaround by function, and by
 * the person who performed it.
 *
 * TWO PROCESSES, NEVER BLENDED. Purchase order approval and sales order
 * approval have different approvers, different targets and different volumes.
 * A single table would let a fast purchase order level flatter a slow credit
 * release, and the same person may act in both, so their figures are kept
 * apart. Every function below therefore belongs to exactly one of the two, and
 * nothing in this module averages across them.
 *
 * THE GAP BETWEEN MEDIAN AND P90 IS THE POINT. An average hides the tail and
 * the tail is where the complaints come from: every approver looks fast at the
 * median. So each row carries volume, median and P90 — never a mean, which one
 * long hold drags away from everybody — and the chart draws median and P90 on
 * the same line so the distance between them is the thing the eye lands on.
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS A FUNCTION, AND WHERE THE TWO CLOCKS COME FROM
 * ---------------------------------------------------------------------------
 *
 * PURCHASE ORDERS. Approval levels are not a purchase-order table; they are
 * generic workflow stages, so a level is `workflow_stages.sequence_no` and its
 * name is `workflow_stages.stage_name`. The person is
 * `workflow_stage_instances.assigned_user_id` and the clock is that row's
 * `started_at` to `completed_at`. Four levels are configured today and the
 * query reads however many exist rather than assuming a number.
 *
 * SALES ORDERS. Four functions, and only two of them record a person:
 *
 *   Finance approval    workflow_stage_instances on FINANCE_APPROVAL.
 *                       Person: assigned_user_id. Clock: started_at →
 *                       completed_at.
 *   Credit release      workflow_stage_instances on CREDIT_CHECK.
 *                       Person: assigned_user_id. Clock: the hold to its
 *                       release.
 *   Invoicing           sales_orders.invoice_created_at. THE EXTRACT CARRIES
 *                       NO ACTOR: there is no INVOICE_BY column and no stage
 *                       instance is written, so the person is genuinely not
 *                       recorded and this module says so rather than guessing
 *                       one. Clock: the latest preceding milestone that is
 *                       known — credit release, else finance approval, else
 *                       the order's creation — to the invoice.
 *   Loading authority   sales_orders.loading_authority_at. NO ACTOR either.
 *                       Clock: the invoice, else the same fallback chain, to
 *                       the authority.
 *
 * The chain is stated because a per-function duration needs a start, and the
 * extract only dates the ends. Measuring every function from the order's
 * creation would charge loading authority for finance's delay; measuring from
 * the previous known milestone charges each function for its own stretch.
 *
 * ELAPSED MINUTES, NOT BUSINESS MINUTES. The bars are wall-clock, because that
 * is what the extract's timestamps support and what a customer experiences.
 * The dashed target is `sla_rules.target_minutes`, which is configured against
 * a business calendar. The two agree inside a working day and diverge across a
 * weekend, and that is disclosed on the page behind the measure's own
 * definition control rather than printed beside every figure.
 *
 * PERCENTILES IN SQL, NOT IN MEMORY. SQLite has no percentile function, so the
 * durations are ranked with a window function and the median and P90 rows are
 * picked by index. That keeps a dashboard of thousands of stage instances to
 * one round trip per grain instead of streaming every duration into the worker
 * to sort it there. The median averages the two middle values on an even
 * count; P90 is the ceiling index, in integer arithmetic because `ceil` is not
 * guaranteed to be compiled in.
 */
import type { Client } from '@libsql/client/web';

const text = (v: unknown): string => String(v ?? '');
const num = (v: unknown): number => Number(v ?? 0);
const maybe = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const maybeText = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Which process a function belongs to. They are never mixed. */
export type ApprovalProcess = 'PURCHASE_ORDER' | 'SALES_ORDER';

export interface FunctionStat {
  /** The function performed, as a person reads it. */
  readonly fn: string;
  /** Ordering within its process: PO level number, SO chain position. */
  readonly order: number;
  readonly volume: number;
  /**
   * THE MEAN IS GONE, AND IT IS MEASURED RATHER THAN A PREFERENCE.
   *
   * On this data a single 23,002-minute hold drags the average upward far
   * enough that it describes nobody in the table. Typical and Slowest 10%
   * answer the two questions an average blurs into one: what a normal
   * approval costs, and what the tail costs. Neither is an average of the
   * other and neither can be recovered from it.
   */
  readonly medianMinutes: number | null;
  readonly p90Minutes: number | null;
  /** From sla_rules where one resolves for this function, else null. */
  readonly targetMinutes: number | null;
  readonly withinTarget: number | null;
  /** How many of the volume had a target at all, so a rate can be checked. */
  readonly measurable: number;
  /** The actionable half of Within SLA, and the count its destination holds. */
  readonly breaches: number;
  /** How many rows the Slowest 10% destination holds, from the same index. */
  readonly tailCount: number;
  /**
   * The extremes, FOR THE ROW DETAIL ONLY. Never a column, never a rank: every
   * person's fastest is a minute or two, and the slowest inverts the ranking
   * because one order left over a holiday decides it.
   */
  readonly fastestMinutes: number | null;
  readonly slowestMinutes: number | null;
  /** The record behind the slowest figure, so the tail opens its cause. */
  readonly slowestEntityId: string | null;
  readonly slowestDocumentNumber: string | null;
}

export interface LeaderRow extends FunctionStat {
  /** Null where the extract records no actor for this function. */
  readonly userId: string | null;
  /** "Not recorded" is rendered by the page, not invented here. */
  readonly person: string | null;
  readonly pending: number;
  /** The oldest thing still waiting on this person for this function. */
  readonly oldestPendingAt: string | null;
  /** That one record, so "Oldest pending" opens it rather than describing it. */
  readonly oldestPendingEntityId: string | null;
}

export interface ApprovalBoard {
  readonly process: ApprovalProcess;
  readonly functions: FunctionStat[];
  readonly leaders: LeaderRow[];
}

export interface ApprovalPeriod {
  readonly from: string;
  readonly before: string;
  readonly label: string;
  readonly fallback: boolean;
}

/** Resolve one month for both Home panels, falling back to the latest month shared by both. */
export async function resolveApprovalPeriod(
  db: Client,
  requested: string | null,
): Promise<ApprovalPeriod> {
  const requestedMonth = requested?.slice(0, 7) ?? null;
  const result = await db.execute({
    sql: `WITH po(month) AS (
            SELECT DISTINCT substr(wsi.completed_at, 1, 7)
              FROM workflow_stage_instances wsi
              JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
             WHERE wi.entity_type = 'PURCHASE_ORDER' AND wsi.completed_at IS NOT NULL
          ), so(month) AS (
            SELECT DISTINCT substr(COALESCE(wsi.completed_at, so.invoice_created_at, so.loading_authority_at), 1, 7)
              FROM sales_orders so
              LEFT JOIN workflow_instances wi ON wi.entity_id = so.sales_order_id AND wi.entity_type = 'SALES_ORDER'
              LEFT JOIN workflow_stage_instances wsi ON wsi.workflow_instance_id = wi.workflow_instance_id
             WHERE COALESCE(wsi.completed_at, so.invoice_created_at, so.loading_authority_at) IS NOT NULL
          ), common(month) AS (SELECT po.month FROM po JOIN so USING (month))
          SELECT CASE WHEN ? IS NOT NULL AND EXISTS (SELECT 1 FROM common WHERE month = ?)
                      THEN ? ELSE (SELECT MAX(month) FROM common) END AS month`,
    args: [requestedMonth, requestedMonth, requestedMonth],
  });
  const raw = (result.rows[0] as Record<string, unknown> | undefined)?.month;
  const month =
    typeof raw === 'string' && /^\d{4}-\d{2}$/.test(raw)
      ? raw
      : new Date().toISOString().slice(0, 7);
  const from = `${month}-01`;
  const next = new Date(`${from}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const label = new Intl.DateTimeFormat('en-KE', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${from}T00:00:00Z`));
  return {
    from,
    before: next.toISOString().slice(0, 10),
    label,
    fallback: requestedMonth !== null && requestedMonth !== month,
  };
}

/**
 * Below this many completed items a person is listed but not ranked.
 *
 * A median over three approvals is noise, and publishing a league table built
 * on noise is how a dashboard turns into an accusation. The number is on the
 * screen beside the table, because a threshold nobody can see is a threshold
 * nobody can argue with.
 */
export const MINIMUM_RANKED_VOLUME = 10;

/*
 * THERE IS NO WINDOW CONSTANT HERE ANY MORE, AND ITS REMOVAL IS THE POINT.
 *
 * This module used to own a rolling 90-day window. On 30 August 2026 that
 * window ran from 1 June, and the one extract in this database ends on 30 May:
 * it missed every row by two days, and nothing on the page said which window
 * it had chosen or that a fuller one existed. The period now arrives from
 * `src/lib/cms/analytics/period.ts`, which is chosen by the reader, visible on
 * the page, carried in the URL, and falls back to the most recent period that
 * holds data rather than rendering an empty chart in silence.
 */

/**
 * The target for a function, from the rule with the highest-precedence active
 * profile.
 *
 * NOT `resolveSlaRule`. That resolver answers for ONE entity, weighing the
 * account, the segment and the affiliate on that row; a dashboard aggregates
 * across all of them, so there is no single account to weigh. The honest
 * aggregate answer is the default rule for the stage: the active rule whose
 * profile has no account, segment or affiliate, at the highest precedence.
 * Where none exists, the function has no target and the chart draws no line.
 */
const TARGET_SQL = `
  SELECT r.target_minutes
    FROM sla_rules r
    JOIN sla_profiles p ON p.sla_profile_id = r.sla_profile_id
   WHERE r.active = 1 AND p.active = 1
     AND r.entity_type = :entity AND r.stage_code = :stage
     AND p.account_id IS NULL AND p.segment IS NULL AND p.affiliate_id IS NULL
   ORDER BY p.precedence_level DESC, r.sla_rule_id
   LIMIT 1`;

/**
 * Rank, then pick. Shared by both processes so the arithmetic cannot drift.
 *
 * `d` must yield: fn, ord, entity_id, document_number, user_id, person,
 * started_at, completed_at, minutes, target_minutes.
 *
 * THE ALIAS BUG THIS FIXES, RECORDED BECAUSE IT COST A DASHBOARD. The outer
 * SELECT reads FROM `ranked`, not from `d`: `d` is consumed by the inner CTE
 * and is out of scope by the time the grouping is applied. Grouping by `d.fn`
 * therefore raised `no such column: d.fn` on every execution, which is why both
 * charts and both leaderboards on Home were empty while the page's own footer
 * still printed the ranking threshold. Nothing about the date window was
 * involved. The regression test in test/cms/approvalSla.test.ts runs this
 * statement against the mirrored schema, so the next person to touch it finds
 * out here rather than in production.
 */
function statsOver(source: string, groupByPerson: boolean): string {
  const key = groupByPerson
    ? 'ranked.fn, ranked.ord, ranked.user_id, ranked.person'
    : 'ranked.fn, ranked.ord';
  const partition = groupByPerson ? 'd.fn, d.user_id' : 'd.fn';
  return `
    WITH d AS (${source}),
    ranked AS (
      SELECT d.*,
             ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY d.minutes) AS rn,
             COUNT(*) OVER (PARTITION BY ${partition}) AS n
        FROM d WHERE d.minutes IS NOT NULL
    )
    SELECT ${key},
           MIN(ranked.target_minutes) AS target_minutes,
           COUNT(*) AS volume,
           -- THE TWO EXTREMES BELONG TO THE ROW DETAIL AND NOWHERE ELSE.
           -- Neither is a column and neither ranks anybody: every person's
           -- fastest is zero to two minutes across every function, so it
           -- distinguishes nobody, and the slowest inverts the ranking because
           -- one order left over a holiday decides it.
           MIN(ranked.minutes) AS fastest_minutes,
           MAX(ranked.minutes) AS slowest_minutes,
           -- The document behind that slowest figure, so the tail is one click
           -- from the record that caused it.
           MAX(CASE WHEN ranked.rn = ranked.n THEN ranked.entity_id END) AS slowest_entity_id,
           MAX(CASE WHEN ranked.rn = ranked.n THEN ranked.document_number END)
             AS slowest_document_number,
           -- The two middle values on an even count, the one middle value on
           -- an odd count, because (n+1)/2 and (n+2)/2 coincide when n is odd.
           AVG(CASE WHEN ranked.rn IN ((ranked.n + 1) / 2, (ranked.n + 2) / 2)
                    THEN ranked.minutes END) AS median_minutes,
           -- ceil(0.9n) in integer arithmetic: ceil is not guaranteed present.
           MAX(CASE WHEN ranked.rn = (ranked.n * 9 + 9) / 10
                    THEN ranked.minutes END) AS p90_minutes,
           -- How many rows the Slowest 10% destination will hold, computed from
           -- the same index the figure is read at, so the count on the page and
           -- the count in the list cannot disagree.
           SUM(CASE WHEN ranked.rn >= (ranked.n * 9 + 9) / 10 THEN 1 ELSE 0 END) AS tail_count,
           SUM(CASE WHEN ranked.target_minutes IS NOT NULL
                     AND ranked.minutes <= ranked.target_minutes THEN 1 ELSE 0 END)
             AS within_target,
           SUM(CASE WHEN ranked.target_minutes IS NULL THEN 0 ELSE 1 END) AS measurable
      FROM ranked
     GROUP BY ${key}`;
}

const MINUTES = (from: string, to: string): string =>
  `CAST(ROUND((julianday(${to}) - julianday(${from})) * 1440.0) AS INTEGER)`;

/**
 * Purchase order approval: every configured level, with the person who acted.
 *
 * The levels are read from `workflow_stages`, so a fifth level configured next
 * month appears without a code change. `terminal_stage` is excluded because
 * the final stage records the outcome rather than an approval.
 *
 * `entity_id` and `document_number` are carried through so a figure can be
 * opened. A dashboard number that cannot be traced to its records is a number
 * nobody can check.
 */
const PO_SOURCE = `
  SELECT ws.stage_name AS fn,
         ws.sequence_no AS ord,
         wi.entity_id AS entity_id,
         po.document_number AS document_number,
         wsi.assigned_user_id AS user_id,
         COALESCE(u.display_name, u.email) AS person,
         wsi.started_at AS started_at,
         wsi.completed_at AS completed_at,
         ${MINUTES('wsi.started_at', 'wsi.completed_at')} AS minutes,
         (SELECT r.target_minutes FROM sla_rules r
            JOIN sla_profiles p ON p.sla_profile_id = r.sla_profile_id
           WHERE r.active = 1 AND p.active = 1
             AND r.entity_type = 'PURCHASE_ORDER' AND r.stage_code = ws.stage_code
             AND p.account_id IS NULL AND p.segment IS NULL AND p.affiliate_id IS NULL
           ORDER BY p.precedence_level DESC, r.sla_rule_id LIMIT 1) AS target_minutes
    FROM workflow_stage_instances wsi
    JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
    JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
    LEFT JOIN users u ON u.user_id = wsi.assigned_user_id
    LEFT JOIN purchase_orders po ON po.purchase_order_id = wi.entity_id
   WHERE wi.entity_type = 'PURCHASE_ORDER'
     AND wsi.status IN ('APPROVED', 'COMPLETED')
     AND wsi.started_at IS NOT NULL AND wsi.completed_at IS NOT NULL
     AND (:from IS NULL OR wsi.completed_at >= :from)
     AND (:to IS NULL OR wsi.completed_at <= :to)`;

/**
 * Sales order: the four functions, two of which have a person and two of which
 * do not.
 *
 * The UNION is what keeps the honest gap visible. The stage-backed halves
 * carry a `user_id`; the order-backed halves carry NULL, and the page renders
 * that as "Not recorded" rather than attributing the work to whoever last
 * touched the order.
 */
const soStage = (fn: string, ord: number, stage: string): string => `
  SELECT '${fn}' AS fn, ${ord} AS ord,
         wi.entity_id AS entity_id,
         so.document_number AS document_number,
         wsi.assigned_user_id AS user_id,
         COALESCE(u.display_name, u.email) AS person,
         wsi.started_at AS started_at,
         wsi.completed_at AS completed_at,
         ${MINUTES('wsi.started_at', 'wsi.completed_at')} AS minutes,
         (SELECT r.target_minutes FROM sla_rules r
            JOIN sla_profiles p ON p.sla_profile_id = r.sla_profile_id
           WHERE r.active = 1 AND p.active = 1
             AND r.entity_type = 'SALES_ORDER' AND r.stage_code = '${stage}'
             AND p.account_id IS NULL AND p.segment IS NULL AND p.affiliate_id IS NULL
           ORDER BY p.precedence_level DESC, r.sla_rule_id LIMIT 1) AS target_minutes
    FROM workflow_stage_instances wsi
    JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
    JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
    LEFT JOIN users u ON u.user_id = wsi.assigned_user_id
    LEFT JOIN sales_orders so ON so.sales_order_id = wi.entity_id
   WHERE wi.entity_type = 'SALES_ORDER' AND ws.stage_code = '${stage}'
     AND wsi.status IN ('APPROVED', 'COMPLETED')
     AND wsi.started_at IS NOT NULL AND wsi.completed_at IS NOT NULL
     AND (:from IS NULL OR wsi.completed_at >= :from)
     AND (:to IS NULL OR wsi.completed_at <= :to)`;

const soOrder = (fn: string, ord: number, endColumn: string, startExpr: string): string => `
  SELECT '${fn}' AS fn, ${ord} AS ord,
         so.sales_order_id AS entity_id,
         so.document_number AS document_number,
         NULL AS user_id, NULL AS person,
         ${startExpr} AS started_at,
         so.${endColumn} AS completed_at,
         ${MINUTES(startExpr, `so.${endColumn}`)} AS minutes,
         NULL AS target_minutes
    FROM sales_orders so
   WHERE so.${endColumn} IS NOT NULL
     AND (:from IS NULL OR so.${endColumn} >= :from)
     AND (:to IS NULL OR so.${endColumn} <= :to)`;

const SO_SOURCE = [
  soStage('Finance approval', 1, 'FINANCE_APPROVAL'),
  soStage('Credit release', 2, 'CREDIT_CHECK'),
  soOrder('Invoicing', 3, 'invoice_created_at', 'so.order_created_at'),
  soOrder(
    'Loading authority',
    4,
    'loading_authority_at',
    'COALESCE(so.invoice_created_at, so.order_created_at)',
  ),
].join('\n\n  UNION ALL\n');

/**
 * What is still waiting, one row per waiting item.
 *
 * Individual rows rather than a count, because the Pending figure and the list
 * behind it must be the same question: the aggregate below is built over this
 * source, and the destination reads this source directly, so the number on the
 * page IS the number of rows in the list rather than a second query written to
 * agree with it.
 */
const PO_PENDING_SOURCE = `
  SELECT ws.stage_name AS fn, ws.sequence_no AS ord,
         wi.entity_id AS entity_id, po.document_number AS document_number,
         wsi.assigned_user_id AS user_id,
         COALESCE(u.display_name, u.email) AS person,
         COALESCE(wsi.started_at, wsi.assigned_at) AS waiting_since
    FROM workflow_stage_instances wsi
    JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
    JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
    LEFT JOIN users u ON u.user_id = wsi.assigned_user_id
    LEFT JOIN purchase_orders po ON po.purchase_order_id = wi.entity_id
   WHERE wi.entity_type = 'PURCHASE_ORDER' AND wsi.status IN ('PENDING', 'ACTIVE')`;

const SO_PENDING_SOURCE = `
  SELECT CASE ws.stage_code WHEN 'FINANCE_APPROVAL' THEN 'Finance approval'
                            ELSE 'Credit release' END AS fn,
         CASE ws.stage_code WHEN 'FINANCE_APPROVAL' THEN 1 ELSE 2 END AS ord,
         wi.entity_id AS entity_id, so.document_number AS document_number,
         wsi.assigned_user_id AS user_id,
         COALESCE(u.display_name, u.email) AS person,
         COALESCE(wsi.started_at, wsi.assigned_at) AS waiting_since
    FROM workflow_stage_instances wsi
    JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
    JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
    LEFT JOIN users u ON u.user_id = wsi.assigned_user_id
    LEFT JOIN sales_orders so ON so.sales_order_id = wi.entity_id
   WHERE wi.entity_type = 'SALES_ORDER' AND wsi.status IN ('PENDING', 'ACTIVE')
     AND ws.stage_code IN ('FINANCE_APPROVAL', 'CREDIT_CHECK')

  UNION ALL

  SELECT 'Invoicing' AS fn, 3 AS ord,
         so.sales_order_id AS entity_id, so.document_number AS document_number,
         NULL AS user_id, NULL AS person,
         so.order_created_at AS waiting_since
    FROM sales_orders so
   WHERE so.invoice_created_at IS NULL AND so.status <> 'CANCELLED'

  UNION ALL

  SELECT 'Loading authority' AS fn, 4 AS ord,
         so.sales_order_id AS entity_id, so.document_number AS document_number,
         NULL AS user_id, NULL AS person,
         COALESCE(so.invoice_created_at, so.order_created_at) AS waiting_since
    FROM sales_orders so
   WHERE so.loading_authority_at IS NULL AND so.status <> 'CANCELLED'`;

/** The pending aggregate, over the very source the destination lists. */
const pendingAggregate = (source: string): string => `
  WITH w AS (${source})
  SELECT w.fn, w.user_id, COUNT(*) AS pending, MIN(w.waiting_since) AS oldest,
         -- The one record behind "Oldest pending", so that figure opens it.
         (SELECT o.entity_id FROM w o
           WHERE o.fn = w.fn AND o.user_id IS w.user_id
           ORDER BY o.waiting_since IS NULL, o.waiting_since LIMIT 1) AS oldest_entity_id
    FROM w
   GROUP BY w.fn, w.user_id`;

const sourceFor = (process: ApprovalProcess): string =>
  process === 'PURCHASE_ORDER' ? PO_SOURCE : SO_SOURCE;
const pendingSourceFor = (process: ApprovalProcess): string =>
  process === 'PURCHASE_ORDER' ? PO_PENDING_SOURCE : SO_PENDING_SOURCE;

const rowsOf = (result: { rows: unknown[] }): Record<string, unknown>[] =>
  result.rows as Record<string, unknown>[];

/** The window as bound arguments. Nulls mean all time, and bind as nulls. */
export function windowArgs(period: {
  from: string | null;
  to: string | null;
}): Record<string, string | null> {
  return {
    from: period.from === null ? null : `${period.from} 00:00:00`,
    to: period.to === null ? null : `${period.to} 23:59:59`,
  };
}

/**
 * One process's chart series and leaderboard, in three round trips.
 *
 * Per-function and per-person are separate queries rather than one query
 * folded in the worker, because the per-function median is the median of ALL
 * the durations and not the median of the per-person medians. Those are
 * different numbers and only one of them is the truth.
 */
export async function approvalBoard(
  db: Client,
  process: ApprovalProcess,
  period: { from: string | null; to: string | null },
): Promise<ApprovalBoard> {
  const source = sourceFor(process);
  const args = windowArgs(period);

  const [byFunction, byPerson, pending] = await Promise.all([
    db.execute({ sql: statsOver(source, false), args }),
    db.execute({ sql: statsOver(source, true), args }),
    db.execute({ sql: pendingAggregate(pendingSourceFor(process)), args: {} }),
  ]);

  const waiting = new Map<
    string,
    { pending: number; oldest: string | null; oldestEntityId: string | null }
  >();
  for (const row of rowsOf(pending)) {
    const key = `${text(row.fn)}|${row.user_id === null ? '' : text(row.user_id)}`;
    waiting.set(key, {
      pending: num(row.pending),
      oldest: row.oldest === null || row.oldest === undefined ? null : text(row.oldest),
      oldestEntityId:
        row.oldest_entity_id === null || row.oldest_entity_id === undefined
          ? null
          : text(row.oldest_entity_id),
    });
  }

  const rate = (within: unknown, measurable: unknown): number | null => {
    const total = num(measurable);
    return total === 0 ? null : num(within) / total;
  };

  const functions: FunctionStat[] = rowsOf(byFunction)
    .map((row) => ({
      fn: text(row.fn),
      order: num(row.ord),
      volume: num(row.volume),
      medianMinutes: maybe(row.median_minutes),
      p90Minutes: maybe(row.p90_minutes),
      targetMinutes: maybe(row.target_minutes),
      withinTarget: rate(row.within_target, row.measurable),
      measurable: num(row.measurable),
      breaches: num(row.measurable) - num(row.within_target),
      tailCount: num(row.tail_count),
      fastestMinutes: maybe(row.fastest_minutes),
      slowestMinutes: maybe(row.slowest_minutes),
      slowestEntityId: maybeText(row.slowest_entity_id),
      slowestDocumentNumber: maybeText(row.slowest_document_number),
    }))
    .sort((a, b) => a.order - b.order);

  const leaders: LeaderRow[] = rowsOf(byPerson)
    .map((row) => {
      const fn = text(row.fn);
      const userId = maybeText(row.user_id);
      const wait = waiting.get(`${fn}|${userId ?? ''}`);
      return {
        fn,
        order: num(row.ord),
        userId,
        person: maybeText(row.person),
        volume: num(row.volume),
        medianMinutes: maybe(row.median_minutes),
        p90Minutes: maybe(row.p90_minutes),
        targetMinutes: maybe(row.target_minutes),
        withinTarget: rate(row.within_target, row.measurable),
        measurable: num(row.measurable),
        breaches: num(row.measurable) - num(row.within_target),
        tailCount: num(row.tail_count),
        fastestMinutes: maybe(row.fastest_minutes),
        slowestMinutes: maybe(row.slowest_minutes),
        slowestEntityId: maybeText(row.slowest_entity_id),
        slowestDocumentNumber: maybeText(row.slowest_document_number),
        pending: wait?.pending ?? 0,
        oldestPendingAt: wait?.oldest ?? null,
        oldestPendingEntityId: wait?.oldestEntityId ?? null,
      };
    })
    // Function first, then slowest median first WITHIN a function, so the
    // reading is "where in this function is time going" and never a single
    // ranking across functions.
    .sort((a, b) =>
      a.order !== b.order ? a.order - b.order : (b.medianMinutes ?? -1) - (a.medianMinutes ?? -1),
    );

  return { process, functions, leaders };
}

/* -------------------------------------------------------------------------
 * THE RECORDS BEHIND A FIGURE
 * ------------------------------------------------------------------------- */

/** Which records a figure opens. One view per clickable column. */
export const RECORD_VIEWS = ['completed', 'typical', 'tail', 'breaches', 'pending'] as const;
export type RecordView = (typeof RECORD_VIEWS)[number];

export interface ApprovalRecord {
  readonly entityId: string | null;
  readonly documentNumber: string | null;
  readonly fn: string;
  readonly person: string | null;
  readonly userId: string | null;
  /** The two timestamps the duration was computed from, so it can be checked. */
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly minutes: number | null;
  readonly targetMinutes: number | null;
  /** True, false, or null where the function has no configured target. */
  readonly withinTarget: boolean | null;
  /** Marked on the `typical` view: the row the median was read at. */
  readonly isMedian: boolean;
}

/**
 * THE COUNT MUST EQUAL THE FIGURE, AND HERE IS WHY IT DOES.
 *
 * Every view below is built over the SAME source expression the aggregate is
 * built over, with the same bound window and the same person predicate, and
 * the tail is cut at the SAME integer index the P90 is read at. The list is
 * therefore not a second query written to agree with the first; it is the
 * first query with the grouping removed. Where an aggregate and a list can
 * only disagree by both being written twice, they are written once.
 *
 * `user_id IS ?` rather than `= ?`, because the two sales order functions
 * genuinely record no actor and a null must match the null row rather than
 * matching nothing.
 */
export async function approvalRecords(
  db: Client,
  process: ApprovalProcess,
  view: RecordView,
  fn: string,
  userId: string | null,
  period: { from: string | null; to: string | null },
): Promise<ApprovalRecord[]> {
  const args = { ...windowArgs(period), fn, uid: userId };

  if (view === 'pending') {
    const found = await db.execute({
      sql: `WITH w AS (${pendingSourceFor(process)})
            SELECT w.entity_id, w.document_number, w.fn, w.person, w.user_id,
                   w.waiting_since AS started_at, NULL AS completed_at,
                   NULL AS minutes, NULL AS target_minutes
              FROM w
             WHERE w.fn = :fn AND w.user_id IS :uid
             ORDER BY w.waiting_since IS NULL, w.waiting_since`,
      args: { fn, uid: userId },
    });
    return rowsOf(found).map((row) => toRecord(row, false));
  }

  const ranked = `
    WITH d AS (${sourceFor(process)}),
    ranked AS (
      SELECT d.*,
             ROW_NUMBER() OVER (PARTITION BY d.fn, d.user_id ORDER BY d.minutes) AS rn,
             COUNT(*) OVER (PARTITION BY d.fn, d.user_id) AS n
        FROM d WHERE d.minutes IS NOT NULL
    )
    SELECT ranked.*,
           CASE WHEN ranked.rn IN ((ranked.n + 1) / 2, (ranked.n + 2) / 2) THEN 1 ELSE 0 END
             AS is_median
      FROM ranked
     WHERE ranked.fn = :fn AND ranked.user_id IS :uid`;

  const where =
    view === 'tail'
      ? ' AND ranked.rn >= (ranked.n * 9 + 9) / 10'
      : view === 'breaches'
        ? ' AND ranked.target_minutes IS NOT NULL AND ranked.minutes > ranked.target_minutes'
        : '';
  // The tail reads slowest first, because the question it answers is which
  // orders made the tail. Everything else reads fastest first, so the median
  // marker sits where a reader expects to find it.
  const order = view === 'tail' ? ' ORDER BY ranked.minutes DESC' : ' ORDER BY ranked.minutes';

  const found = await db.execute({ sql: `${ranked}${where}${order}`, args });
  return rowsOf(found).map((row) => toRecord(row, num(row.is_median) === 1));
}

function toRecord(row: Record<string, unknown>, isMedian: boolean): ApprovalRecord {
  const minutes = maybe(row.minutes);
  const target = maybe(row.target_minutes);
  return {
    entityId: maybeText(row.entity_id),
    documentNumber: maybeText(row.document_number),
    fn: text(row.fn),
    person: maybeText(row.person),
    userId: maybeText(row.user_id),
    startedAt: maybeText(row.started_at),
    completedAt: maybeText(row.completed_at),
    minutes,
    targetMinutes: target,
    withinTarget: target === null || minutes === null ? null : minutes <= target,
    isMedian,
  };
}

export { TARGET_SQL };
