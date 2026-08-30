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
 * median. So each row carries volume, mean, median and P90, and the chart
 * draws median and P90 on the same line so the distance between them is the
 * thing the eye lands on.
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

/** Which process a function belongs to. They are never mixed. */
export type ApprovalProcess = 'PURCHASE_ORDER' | 'SALES_ORDER';

export interface FunctionStat {
  /** The function performed, as a person reads it. */
  readonly fn: string;
  /** Ordering within its process: PO level number, SO chain position. */
  readonly order: number;
  readonly volume: number;
  readonly meanMinutes: number | null;
  readonly medianMinutes: number | null;
  readonly p90Minutes: number | null;
  /** From sla_rules where one resolves for this function, else null. */
  readonly targetMinutes: number | null;
  readonly withinTarget: number | null;
}

export interface LeaderRow extends FunctionStat {
  /** Null where the extract records no actor for this function. */
  readonly userId: string | null;
  /** "Not recorded" is rendered by the page, not invented here. */
  readonly person: string | null;
  readonly pending: number;
  /** The oldest thing still waiting on this person for this function. */
  readonly oldestPendingAt: string | null;
}

export interface ApprovalBoard {
  readonly process: ApprovalProcess;
  readonly functions: FunctionStat[];
  readonly leaders: LeaderRow[];
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

/**
 * The window the figures are taken over, in days back from now.
 *
 * Long enough that a quarterly approver appears, short enough that last year's
 * process does not flatter this year's.
 */
export const WINDOW_DAYS = 90;

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
 * `d` must yield: fn, ord, user_id, person, minutes, target_minutes.
 */
function statsOver(source: string, groupByPerson: boolean): string {
  const key = groupByPerson ? 'd.fn, d.ord, d.user_id, d.person' : 'd.fn, d.ord';
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
           AVG(ranked.minutes) AS mean_minutes,
           -- The two middle values on an even count, the one middle value on
           -- an odd count, because (n+1)/2 and (n+2)/2 coincide when n is odd.
           AVG(CASE WHEN ranked.rn IN ((ranked.n + 1) / 2, (ranked.n + 2) / 2)
                    THEN ranked.minutes END) AS median_minutes,
           -- ceil(0.9n) in integer arithmetic: ceil is not guaranteed present.
           MAX(CASE WHEN ranked.rn = (ranked.n * 9 + 9) / 10
                    THEN ranked.minutes END) AS p90_minutes,
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
 */
const PO_SOURCE = `
  SELECT ws.stage_name AS fn,
         ws.sequence_no AS ord,
         wsi.assigned_user_id AS user_id,
         COALESCE(u.display_name, u.email) AS person,
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
   WHERE wi.entity_type = 'PURCHASE_ORDER'
     AND wsi.status IN ('APPROVED', 'COMPLETED')
     AND wsi.started_at IS NOT NULL AND wsi.completed_at IS NOT NULL
     AND wsi.completed_at >= :since`;

/**
 * Sales order: the four functions, two of which have a person and two of which
 * do not.
 *
 * The UNION is what keeps the honest gap visible. The stage-backed halves
 * carry a `user_id`; the order-backed halves carry NULL, and the page renders
 * that as "Not recorded" rather than attributing the work to whoever last
 * touched the order.
 */
const SO_SOURCE = `
  SELECT 'Finance approval' AS fn, 1 AS ord,
         wsi.assigned_user_id AS user_id,
         COALESCE(u.display_name, u.email) AS person,
         ${MINUTES('wsi.started_at', 'wsi.completed_at')} AS minutes,
         (SELECT r.target_minutes FROM sla_rules r
            JOIN sla_profiles p ON p.sla_profile_id = r.sla_profile_id
           WHERE r.active = 1 AND p.active = 1
             AND r.entity_type = 'SALES_ORDER' AND r.stage_code = 'FINANCE_APPROVAL'
             AND p.account_id IS NULL AND p.segment IS NULL AND p.affiliate_id IS NULL
           ORDER BY p.precedence_level DESC, r.sla_rule_id LIMIT 1) AS target_minutes
    FROM workflow_stage_instances wsi
    JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
    JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
    LEFT JOIN users u ON u.user_id = wsi.assigned_user_id
   WHERE wi.entity_type = 'SALES_ORDER' AND ws.stage_code = 'FINANCE_APPROVAL'
     AND wsi.status IN ('APPROVED', 'COMPLETED')
     AND wsi.started_at IS NOT NULL AND wsi.completed_at IS NOT NULL
     AND wsi.completed_at >= :since

  UNION ALL

  SELECT 'Credit release' AS fn, 2 AS ord,
         wsi.assigned_user_id AS user_id,
         COALESCE(u.display_name, u.email) AS person,
         ${MINUTES('wsi.started_at', 'wsi.completed_at')} AS minutes,
         (SELECT r.target_minutes FROM sla_rules r
            JOIN sla_profiles p ON p.sla_profile_id = r.sla_profile_id
           WHERE r.active = 1 AND p.active = 1
             AND r.entity_type = 'SALES_ORDER' AND r.stage_code = 'CREDIT_CHECK'
             AND p.account_id IS NULL AND p.segment IS NULL AND p.affiliate_id IS NULL
           ORDER BY p.precedence_level DESC, r.sla_rule_id LIMIT 1) AS target_minutes
    FROM workflow_stage_instances wsi
    JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
    JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
    LEFT JOIN users u ON u.user_id = wsi.assigned_user_id
   WHERE wi.entity_type = 'SALES_ORDER' AND ws.stage_code = 'CREDIT_CHECK'
     AND wsi.status IN ('APPROVED', 'COMPLETED')
     AND wsi.started_at IS NOT NULL AND wsi.completed_at IS NOT NULL
     AND wsi.completed_at >= :since

  UNION ALL

  SELECT 'Invoicing' AS fn, 3 AS ord, NULL AS user_id, NULL AS person,
         ${MINUTES('so.order_created_at', 'so.invoice_created_at')} AS minutes,
         NULL AS target_minutes
    FROM sales_orders so
   WHERE so.invoice_created_at IS NOT NULL
     AND so.invoice_created_at >= :since

  UNION ALL

  SELECT 'Loading authority' AS fn, 4 AS ord, NULL AS user_id, NULL AS person,
         ${MINUTES('COALESCE(so.invoice_created_at, so.order_created_at)', 'so.loading_authority_at')}
           AS minutes,
         NULL AS target_minutes
    FROM sales_orders so
   WHERE so.loading_authority_at IS NOT NULL
     AND so.loading_authority_at >= :since`;

/** What is still waiting, per function and per person. */
const PO_PENDING = `
  SELECT ws.stage_name AS fn, wsi.assigned_user_id AS user_id,
         COUNT(*) AS pending, MIN(COALESCE(wsi.started_at, wsi.assigned_at)) AS oldest
    FROM workflow_stage_instances wsi
    JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
    JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
   WHERE wi.entity_type = 'PURCHASE_ORDER' AND wsi.status IN ('PENDING', 'ACTIVE')
   GROUP BY ws.stage_name, wsi.assigned_user_id`;

const SO_PENDING = `
  SELECT CASE ws.stage_code WHEN 'FINANCE_APPROVAL' THEN 'Finance approval'
                            ELSE 'Credit release' END AS fn,
         wsi.assigned_user_id AS user_id,
         COUNT(*) AS pending, MIN(COALESCE(wsi.started_at, wsi.assigned_at)) AS oldest
    FROM workflow_stage_instances wsi
    JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
    JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
   WHERE wi.entity_type = 'SALES_ORDER' AND wsi.status IN ('PENDING', 'ACTIVE')
     AND ws.stage_code IN ('FINANCE_APPROVAL', 'CREDIT_CHECK')
   GROUP BY fn, wsi.assigned_user_id

  UNION ALL

  SELECT 'Invoicing' AS fn, NULL AS user_id,
         COUNT(*) AS pending, MIN(so.order_created_at) AS oldest
    FROM sales_orders so
   WHERE so.invoice_created_at IS NULL AND so.status <> 'CANCELLED'

  UNION ALL

  SELECT 'Loading authority' AS fn, NULL AS user_id,
         COUNT(*) AS pending, MIN(COALESCE(so.invoice_created_at, so.order_created_at)) AS oldest
    FROM sales_orders so
   WHERE so.loading_authority_at IS NULL AND so.status <> 'CANCELLED'`;

const rowsOf = (result: { rows: unknown[] }): Record<string, unknown>[] =>
  result.rows as Record<string, unknown>[];

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
  since: string,
): Promise<ApprovalBoard> {
  const source = process === 'PURCHASE_ORDER' ? PO_SOURCE : SO_SOURCE;
  const pendingSql = process === 'PURCHASE_ORDER' ? PO_PENDING : SO_PENDING;

  const [byFunction, byPerson, pending] = await Promise.all([
    db.execute({ sql: statsOver(source, false), args: { since } }),
    db.execute({ sql: statsOver(source, true), args: { since } }),
    db.execute({ sql: pendingSql, args: {} }),
  ]);

  const waiting = new Map<string, { pending: number; oldest: string | null }>();
  for (const row of rowsOf(pending)) {
    const key = `${text(row.fn)}|${row.user_id === null ? '' : text(row.user_id)}`;
    waiting.set(key, {
      pending: num(row.pending),
      oldest: row.oldest === null || row.oldest === undefined ? null : text(row.oldest),
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
      meanMinutes: maybe(row.mean_minutes),
      medianMinutes: maybe(row.median_minutes),
      p90Minutes: maybe(row.p90_minutes),
      targetMinutes: maybe(row.target_minutes),
      withinTarget: rate(row.within_target, row.measurable),
    }))
    .sort((a, b) => a.order - b.order);

  const leaders: LeaderRow[] = rowsOf(byPerson)
    .map((row) => {
      const fn = text(row.fn);
      const userId = row.user_id === null || row.user_id === undefined ? null : text(row.user_id);
      const wait = waiting.get(`${fn}|${userId ?? ''}`);
      return {
        fn,
        order: num(row.ord),
        userId,
        person: row.person === null || row.person === undefined ? null : text(row.person),
        volume: num(row.volume),
        meanMinutes: maybe(row.mean_minutes),
        medianMinutes: maybe(row.median_minutes),
        p90Minutes: maybe(row.p90_minutes),
        targetMinutes: maybe(row.target_minutes),
        withinTarget: rate(row.within_target, row.measurable),
        pending: wait?.pending ?? 0,
        oldestPendingAt: wait?.oldest ?? null,
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

/** The cut-off timestamp for the window, in the database's own format. */
export function windowStart(now: Date, days = WINDOW_DAYS): string {
  const from = new Date(now.getTime() - days * 86400000);
  return from.toISOString().slice(0, 19).replace('T', ' ');
}

export { TARGET_SQL };
