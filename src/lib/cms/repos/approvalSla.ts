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
import { bucketFor, type PeriodGrain } from '../analytics/period.ts';
import { natureGroupSql, UNGROUPED } from '../analytics/productGroups.ts';

const text = (v: unknown): string => String(v ?? '');
const num = (v: unknown): number => Number(v ?? 0);
const maybe = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const maybeText = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Which process a function belongs to. They are never mixed. */
export type ApprovalProcess = 'PURCHASE_ORDER' | 'SALES_ORDER';

/**
 * WHAT EVERY QUERY IN THIS MODULE IS SCOPED BY, AS ONE VALUE.
 *
 * The period and the affiliate arrive together or not at all. That is a shape
 * decision rather than a tidiness one: the day an aggregate is narrowed by an
 * affiliate and the list behind it is not, the figure and its records disagree
 * with no error anywhere, and a reader has no way to tell which is right. A
 * single required parameter means a call site cannot forget half of the scope,
 * because there is no half to pass.
 *
 * `affiliateId` null is "every affiliate", not "the null affiliate". Purchase
 * orders genuinely carry no affiliate — the extract has no such column and the
 * schema records the fact — so a Group-wide purchase order is IN SCOPE for
 * every affiliate rather than excluded from all of them. Excluding it would
 * empty the whole purchase order panel the moment anybody used the control,
 * which reads exactly like a period with no work in it and is the worst
 * available answer.
 */
export interface ApprovalScope {
  /** Inclusive floor, "YYYY-MM-DD". Null for all time. */
  readonly from: string | null;
  /** Inclusive ceiling, "YYYY-MM-DD". Null for all time. */
  readonly to: string | null;
  /** Null for every affiliate. */
  readonly affiliateId: string | null;
}

/**
 * Whose records a list is for.
 *
 * THREE STATES, NOT TWO, AND THE THIRD IS WHY THIS TYPE EXISTS. A bar on the
 * chart is a whole function across everybody; a row in the table is one person;
 * and invoicing and loading authority are a function whose actor is genuinely
 * not recorded. `null` and "everybody" are different questions and a nullable
 * string cannot ask both, which is how a function-level drill silently returned
 * nothing at all.
 */
export type ApprovalActor =
  | { readonly kind: 'EVERYONE' }
  | { readonly kind: 'PERSON'; readonly userId: string | null };

export const EVERYONE: ApprovalActor = { kind: 'EVERYONE' };

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

/**
 * Elapsed minutes, and NEVER A NEGATIVE ONE.
 *
 * A negative elapsed time is not a fast approval, it is two timestamps in the
 * wrong order, and the real extract carries them: some sales orders record a
 * loading authority BEFORE the invoice the authority is measured from. Left
 * alone those rows drag a median below zero and the chart prints "-19 min",
 * which is a figure no order took and a claim about the business that is simply
 * false. So an out-of-order pair is UNMEASURABLE and yields NULL, exactly as a
 * missing timestamp already does — the row stays in the population, it stays
 * countable, and it contributes no duration it cannot support.
 *
 * COUNTED IN WHOLE SECONDS, NOT JULIAN DAYS. A span of exactly 29 minutes 30
 * seconds is 29.5 minutes and rounds to 30 — the figure the importer recorded
 * from the same two timestamps. Through julianday arithmetic the same span
 * comes out as 29.49999… and rounds to 29, so the chart disagreed with the
 * source extract by a minute on every half-minute boundary. `strftime('%s')`
 * is integer seconds, the subtraction is exact, and halves are representable,
 * so ROUND lands where the importer's own arithmetic does.
 */
const MINUTES = (from: string, to: string): string =>
  `CASE WHEN ${from} IS NULL OR ${to} IS NULL
             OR CAST(strftime('%s', ${to}) AS INTEGER) < CAST(strftime('%s', ${from}) AS INTEGER)
        THEN NULL
        ELSE CAST(ROUND((CAST(strftime('%s', ${to}) AS INTEGER)
                         - CAST(strftime('%s', ${from}) AS INTEGER)) / 60.0) AS INTEGER) END`;

/**
 * The affiliate narrowing, written once and pasted into every source.
 *
 * A GROUP-WIDE ROW IS IN SCOPE FOR EVERY AFFILIATE. `affiliate_id IS NULL` is
 * not a missing value to be filtered out; on a purchase order it is the only
 * value there is, because the extract carries no affiliate column and the
 * schema declares the column nullable for exactly that reason. So the predicate
 * admits three cases and states each: no affiliate chosen, this row is
 * Group-wide, or this row belongs to the affiliate chosen.
 *
 * Named rather than positional, matching `:from` and `:to`, because every one
 * of these sources is UNIONed with another and a positional parameter would
 * have to be bound once per arm in the right order.
 */
const AFFILIATE = (column: string): string =>
  `(:affiliate IS NULL OR ${column} IS NULL OR ${column} = :affiliate)`;

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
/**
 * The product group of a purchase order, read from the extract's own NATURE.
 *
 * NATURE never reached a canonical column — Build Prompt 33 established that
 * mapping it onto the catalogue would file pastries under LPG — so it lives on
 * the landing rows, keyed by purchase number. One order can land in several
 * batches; MAX() makes the read deterministic when it does, and on the real
 * extract every batch agrees with itself. The CASE is built in
 * ../analytics/productGroups.ts, the ONE place the mapping exists.
 */
const PO_GROUP_JOIN = `
    LEFT JOIN (SELECT per.purchase_number,
                      ${natureGroupSql('MAX(per.nature)')} AS grp
                 FROM po_extract_rows per
                WHERE per.purchase_number IS NOT NULL
                GROUP BY per.purchase_number) nat
      ON nat.purchase_number = po.document_number`;

const PO_SOURCE = `
  SELECT ws.stage_name AS fn,
         ws.sequence_no AS ord,
         wi.entity_id AS entity_id,
         po.document_number AS document_number,
         COALESCE(nat.grp, '${UNGROUPED}') AS grp,
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
    LEFT JOIN purchase_orders po ON po.purchase_order_id = wi.entity_id${PO_GROUP_JOIN}
   WHERE wi.entity_type = 'PURCHASE_ORDER'
     AND wsi.status IN ('APPROVED', 'COMPLETED')
     AND wsi.started_at IS NOT NULL AND wsi.completed_at IS NOT NULL
     AND ${AFFILIATE('po.affiliate_id')}
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
const soStage = (fn: string, ord: number, stage: string, scoped = true): string => `
  SELECT '${fn}' AS fn, ${ord} AS ord,
         wi.entity_id AS entity_id,
         so.document_number AS document_number,
         so.affiliate_id AS affiliate_id,
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
     AND ${scoped ? AFFILIATE('so.affiliate_id') : '1 = 1'}
     AND (:from IS NULL OR wsi.completed_at >= :from)
     AND (:to IS NULL OR wsi.completed_at <= :to)`;

const soOrder = (
  fn: string,
  ord: number,
  endColumn: string,
  startExpr: string,
  scoped = true,
): string => `
  SELECT '${fn}' AS fn, ${ord} AS ord,
         so.sales_order_id AS entity_id,
         so.document_number AS document_number,
         so.affiliate_id AS affiliate_id,
         NULL AS user_id, NULL AS person,
         ${startExpr} AS started_at,
         so.${endColumn} AS completed_at,
         ${MINUTES(startExpr, `so.${endColumn}`)} AS minutes,
         NULL AS target_minutes
    FROM sales_orders so
   WHERE so.${endColumn} IS NOT NULL
     AND ${scoped ? AFFILIATE('so.affiliate_id') : '1 = 1'}
     AND (:from IS NULL OR so.${endColumn} >= :from)
     AND (:to IS NULL OR so.${endColumn} <= :to)`;

/**
 * WHERE THE LOADING AUTHORITY CLOCK STARTS, AND WHY IT IS NOT THE INVOICE.
 *
 * It used to be the invoice, falling back to the order — the chain every other
 * sales order function uses, on the reasoning that each function should be
 * charged for its own stretch rather than for the delay before it.
 *
 * THE DATA REFUTES THAT ORDER OF EVENTS. On the real extract the loading
 * authority is issued BEFORE the invoice on 659 of the 664 orders that have
 * one — minutes before, consistently: authority 12:30, invoice 12:35. So the
 * duration came out negative, `MINUTES()` correctly refused to call a negative
 * span a fast one, and the panel reported loading authority over FIVE orders
 * while the business had 664. A figure computed from a milestone that happens
 * afterwards is not a conservative figure; it is a silently empty one.
 *
 * The order's creation always precedes the authority, and it is what the
 * "Order to loading authority" card above the panel already measures, so the
 * panel and that card now answer the same question the same way.
 */
const LOADING_AUTHORITY_START = 'so.order_created_at';

const SO_SOURCE = [
  soStage('Finance approval', 1, 'FINANCE_APPROVAL'),
  soStage('Credit release', 2, 'CREDIT_CHECK'),
  soOrder('Invoicing', 3, 'invoice_created_at', 'so.order_created_at'),
  soOrder('Loading authority', 4, 'loading_authority_at', LOADING_AUTHORITY_START),
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
   WHERE wi.entity_type = 'PURCHASE_ORDER' AND wsi.status IN ('PENDING', 'ACTIVE')
     AND ${AFFILIATE('po.affiliate_id')}`;

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
     AND ${AFFILIATE('so.affiliate_id')}

  UNION ALL

  SELECT 'Invoicing' AS fn, 3 AS ord,
         so.sales_order_id AS entity_id, so.document_number AS document_number,
         NULL AS user_id, NULL AS person,
         so.order_created_at AS waiting_since
    FROM sales_orders so
   WHERE so.invoice_created_at IS NULL AND so.status <> 'CANCELLED'
     AND ${AFFILIATE('so.affiliate_id')}

  UNION ALL

  SELECT 'Loading authority' AS fn, 4 AS ord,
         so.sales_order_id AS entity_id, so.document_number AS document_number,
         NULL AS user_id, NULL AS person,
         COALESCE(so.invoice_created_at, so.order_created_at) AS waiting_since
    FROM sales_orders so
   WHERE so.loading_authority_at IS NULL AND so.status <> 'CANCELLED'
     AND ${AFFILIATE('so.affiliate_id')}`;

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
export function windowArgs(scope: ApprovalScope): Record<string, string | null> {
  return {
    from: scope.from === null ? null : `${scope.from} 00:00:00`,
    to: scope.to === null ? null : `${scope.to} 23:59:59`,
    affiliate: scope.affiliateId,
  };
}

/**
 * The pending sources carry no window, so they bind the affiliate and nothing
 * else. Passing the whole of `windowArgs` here would send `:from` and `:to` to
 * a statement that never mentions them.
 */
export function pendingArgs(scope: ApprovalScope): Record<string, string | null> {
  return { affiliate: scope.affiliateId };
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
  scope: ApprovalScope,
): Promise<ApprovalBoard> {
  const source = sourceFor(process);
  const args = windowArgs(scope);

  const [byFunction, byPerson, pending] = await Promise.all([
    db.execute({ sql: statsOver(source, false), args }),
    db.execute({ sql: statsOver(source, true), args }),
    db.execute({ sql: pendingAggregate(pendingSourceFor(process)), args: pendingArgs(scope) }),
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
 * THE WHOLE PROCESS, END TO END
 * ------------------------------------------------------------------------- */

/** One process's end-to-end span over the period. */
export interface CycleStat {
  /** Orders the span could be measured on. This is the KPI's denominator. */
  readonly orders: number;
  readonly medianMinutes: number | null;
  readonly p90Minutes: number | null;
}

/**
 * The end-to-end span, and it is a DIFFERENT QUESTION PER PROCESS because the
 * two processes end in different places.
 *
 * PURCHASE ORDERS: submission to final approval. The levels are the whole of
 * the approval, so the span is the earliest level start to the latest level
 * completion on the same order. Reading it off the levels rather than off
 * `purchase_orders` is deliberate: it is then the same population the bars and
 * the table are drawn from, so the strip cannot report a figure over orders the
 * panel beneath it never saw.
 *
 * SALES ORDERS: order creation to loading authority. That one is NOT the span
 * of the four functions, and the difference matters. An order with no invoice
 * yet has a first start of "finance approval" and a last completion of "credit
 * release", and calling that an order-to-authority time would be false on every
 * such row. So it is measured on the two timestamps it actually names, over the
 * orders that reached an authority, and the count of those orders is returned
 * as the figure's denominator rather than left implied.
 *
 * A MEDIAN OF MEDIANS IS NOT A MEDIAN, which is why this exists at all: the
 * strip cannot be assembled from `board.functions`. The arithmetic is the same
 * nearest-rank pair used everywhere else in this module, so the strip and the
 * bars agree by construction.
 */
export async function approvalCycle(
  db: Client,
  process: ApprovalProcess,
  scope: ApprovalScope,
): Promise<CycleStat> {
  const spans =
    process === 'PURCHASE_ORDER'
      ? `WITH d AS (${PO_SOURCE}),
         per AS (
           SELECT d.entity_id AS entity_id,
                  MIN(d.started_at) AS started_at,
                  MAX(d.completed_at) AS completed_at
             FROM d WHERE d.minutes IS NOT NULL
            GROUP BY d.entity_id
         ),
         spans AS (
           SELECT ${MINUTES('per.started_at', 'per.completed_at')} AS minutes FROM per
         )`
      : `WITH spans AS (
           SELECT ${MINUTES('so.order_created_at', 'so.loading_authority_at')} AS minutes
             FROM sales_orders so
            WHERE so.loading_authority_at IS NOT NULL
              AND so.order_created_at IS NOT NULL
              AND ${AFFILIATE('so.affiliate_id')}
              AND (:from IS NULL OR so.loading_authority_at >= :from)
              AND (:to IS NULL OR so.loading_authority_at <= :to)
         )`;
  const found = await db.execute({
    sql: `${spans},
      ranked AS (
        SELECT spans.minutes AS minutes,
               ROW_NUMBER() OVER (ORDER BY spans.minutes) AS rn,
               COUNT(*) OVER () AS n
          FROM spans WHERE spans.minutes IS NOT NULL
      )
      SELECT COUNT(*) AS orders,
             AVG(CASE WHEN ranked.rn IN ((ranked.n + 1) / 2, (ranked.n + 2) / 2)
                      THEN ranked.minutes END) AS median_minutes,
             MAX(CASE WHEN ranked.rn = (ranked.n * 9 + 9) / 10
                      THEN ranked.minutes END) AS p90_minutes
        FROM ranked`,
    args: windowArgs(scope),
  });
  const row = (rowsOf(found)[0] ?? {}) as Record<string, unknown>;
  return {
    orders: num(row.orders),
    medianMinutes: maybe(row.median_minutes),
    p90Minutes: maybe(row.p90_minutes),
  };
}

/* -------------------------------------------------------------------------
 * THE SAME FUNCTIONS, OVER TIME
 * ------------------------------------------------------------------------- */

/** One function's typical turnaround in one bucket of the period. */
export interface TrendPoint {
  readonly fn: string;
  readonly order: number;
  /** Matches `bucketFor`'s output for the grain, so a bucket can be looked up. */
  readonly bucket: string;
  readonly volume: number;
  readonly medianMinutes: number | null;
}

/**
 * The typical turnaround per function per bucket, in ONE statement.
 *
 * THE MEDIAN HERE IS THE SAME ARITHMETIC AS THE BAR ABOVE IT, and that is not
 * a coincidence to be maintained by hand: both mean the two middle values on an
 * even count and the one middle value on an odd one. Two medians on one page
 * computed two ways is how a trend and a bar quietly disagree about the same
 * month, and neither can then be checked against the other. `poPerformance` and
 * `soPerformance` both carry a nearest-rank median, which is a different
 * figure, so neither is reused here.
 *
 * THE BUCKET IS MATERIALISED IN ITS OWN CTE. A `SELECT`-list alias cannot be
 * referenced by a `PARTITION BY` in the same `SELECT`, and the outer statement
 * reads FROM `ranked` rather than from `d` for the reason recorded against
 * `statsOver`: `d` is out of scope by then, and grouping by it raises
 * `no such column` on every execution.
 *
 * Buckets with no completions return no row rather than a zero. The caller
 * enumerates the period with `periodBuckets` and fills the gaps with null, so
 * a quiet day breaks the line instead of being drawn as an instant approval.
 */
export async function approvalTrend(
  db: Client,
  process: ApprovalProcess,
  scope: ApprovalScope,
  grain: PeriodGrain,
): Promise<TrendPoint[]> {
  const sql = `
    WITH d AS (${sourceFor(process)}),
    bucketed AS (
      SELECT d.fn AS fn, d.ord AS ord, d.minutes AS minutes,
             ${bucketFor('d.completed_at', grain)} AS bucket
        FROM d WHERE d.minutes IS NOT NULL AND d.completed_at IS NOT NULL
    ),
    ranked AS (
      SELECT bucketed.*,
             ROW_NUMBER() OVER (PARTITION BY bucketed.fn, bucketed.bucket
                                ORDER BY bucketed.minutes) AS rn,
             COUNT(*) OVER (PARTITION BY bucketed.fn, bucketed.bucket) AS n
        FROM bucketed
    )
    SELECT ranked.fn, ranked.ord, ranked.bucket,
           COUNT(*) AS volume,
           AVG(CASE WHEN ranked.rn IN ((ranked.n + 1) / 2, (ranked.n + 2) / 2)
                    THEN ranked.minutes END) AS median_minutes
      FROM ranked
     GROUP BY ranked.fn, ranked.ord, ranked.bucket`;
  const found = await db.execute({ sql, args: windowArgs(scope) });
  return rowsOf(found)
    .map((row) => ({
      fn: text(row.fn),
      order: num(row.ord),
      bucket: text(row.bucket),
      volume: num(row.volume),
      medianMinutes: maybe(row.median_minutes),
    }))
    .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.bucket.localeCompare(b.bucket)));
}

/* -------------------------------------------------------------------------
 * THE RECORDS BEHIND A FIGURE
 * ------------------------------------------------------------------------- */

/** Which records a figure opens. One view per clickable column. */
export const RECORD_VIEWS = ['completed', 'typical', 'tail', 'breaches', 'pending'] as const;
export type RecordView = (typeof RECORD_VIEWS)[number];

/**
 * WHICH CLOCK THE FIGURE THAT OPENED THIS LIST WAS READ ON.
 *
 * The approver chart's figures are working-day minutes, because that is what
 * the rule measures; the leaderboard's are wall clock, because that is what
 * it has always shown. A list must rank, cut and judge on the SAME clock as
 * the figure that opened it or the count stops matching, so the clock travels
 * in the URL rather than being inferred from the process.
 */
export const RECORD_CLOCKS = ['WALL', 'WORKING'] as const;
// Named for the columns the destination prints — "Wall clock" and "Working
// hours" — so the URL, the code and the page a reader lands on all use one
// vocabulary for the same two measurements.
export type RecordClock = (typeof RECORD_CLOCKS)[number];

export interface ApprovalRecord {
  readonly entityId: string | null;
  readonly documentNumber: string | null;
  readonly fn: string;
  readonly person: string | null;
  readonly userId: string | null;
  /** The two timestamps the duration was computed from, so it can be checked. */
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** The wall clock: start to finish, whatever the hour. */
  readonly minutes: number | null;
  /**
   * The same span counted inside the working day, where a purchase order rule
   * configures one. Null on sales orders and wherever no rule resolves.
   *
   * BOTH ARE CARRIED, NEITHER IS BLENDED. They are different measurements of
   * the same span and the page prints them in separate columns under separate
   * headings, because a figure that silently switches clock is a figure
   * nobody can check.
   */
  readonly workingMinutes: number | null;
  readonly targetMinutes: number | null;
  /** The process-wide target from the active rule, where one resolves. */
  readonly ruleTargetMinutes: number | null;
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
  actor: ApprovalActor,
  scope: ApprovalScope,
  /**
   * The product group of the purchase order chart, where a figure carries
   * one. Purchase orders only: the sales source has no NATURE and the group
   * chart never links here with one for it.
   */
  productGroup: string | null = null,
  /** The clock the figure was read on. Purchase orders only. */
  clock: RecordClock = 'WALL',
): Promise<ApprovalRecord[]> {
  const person = actor.kind === 'PERSON';
  // AN EMPTY FUNCTION MEANS EVERY FUNCTION IN THE PROCESS, which is what the
  // panel's own headline figure counts: every completion the chart's bars add
  // up to. It is only ever paired with EVERYONE — "every function, for one
  // person" is a question no figure on the page asks — and the parameter is
  // dropped from the bind rather than left unused, because an argument a
  // statement never mentions is refused by the driver.
  // An empty function is every function: the approver chart's figures are a
  // person across every level they touched, and the panel's headline figure is
  // everybody across every function. The parameter is dropped from the bind
  // rather than left unused, because an argument a statement never mentions is
  // refused by the driver.
  const everyFunction = fn === '';
  const group = process === 'PURCHASE_ORDER' ? productGroup : null;
  const args = {
    ...windowArgs(scope),
    ...(everyFunction ? {} : { fn }),
    ...(person ? { uid: actor.userId } : {}),
    ...(group === null ? {} : { grp: group }),
  };

  // THE PARTITION MUST MATCH THE AGGREGATE THAT PRODUCED THE FIGURE, and this
  // is the whole reason `ApprovalActor` has three states rather than two.
  //
  // A leaderboard row's figures come from `statsOver(source, true)`, which
  // partitions by function AND person; a chart bar's come from
  // `statsOver(source, false)`, which partitions by function alone. Those are
  // different populations, so they have a different n, a different median row
  // and a different tail index. Listing a bar's records with the per-person
  // partition would cut the tail at the wrong index and count the wrong number
  // of rows — the exact class of defect where a figure and its own list
  // disagree. A group-chart figure's partition is person and group (and level
  // where expanded), so a group filter joins the partition too.
  const partition = person
    ? [
        'd.user_id',
        ...(group === null ? [] : ['d.grp']),
        // AND NOT BY FUNCTION WHERE THE FIGURE WAS NOT. An approver's figure
        // on the chart is a median over every level they touched, so a
        // partition that still split by level would mark the wrong median row
        // and cut the tail at the wrong index.
        ...(everyFunction ? [] : ['d.fn']),
      ].join(', ')
    : 'd.fn';
  const who = person ? ' AND ranked.user_id IS :uid' : '';
  const inGroup = group === null ? '' : ' AND ranked.grp = :grp';

  if (view === 'pending') {
    const found = await db.execute({
      sql: `WITH w AS (${pendingSourceFor(process)})
            SELECT w.entity_id, w.document_number, w.fn, w.person, w.user_id,
                   w.waiting_since AS started_at, NULL AS completed_at,
                   NULL AS minutes, NULL AS target_minutes
              FROM w
             WHERE ${everyFunction ? '1 = 1' : 'w.fn = :fn'}${
               person ? ' AND w.user_id IS :uid' : ''
             }
             ORDER BY w.waiting_since IS NULL, w.waiting_since`,
      args: {
        ...pendingArgs(scope),
        ...(everyFunction ? {} : { fn }),
        ...(person ? { uid: actor.userId } : {}),
      },
    });
    return rowsOf(found).map((row) => toRecord(row, false));
  }

  // THE SAME EXPRESSIONS THE BOARD USES, so a figure and its list cannot
  // judge against different windows. Sales orders have no rule and no
  // working-day clock, so their statement is exactly what it has always been.
  // THE SAME EXPRESSIONS THE PANELS USE, so a figure and the list behind it
  // cannot judge against different windows or different targets.
  //
  // A purchase order is judged by the one active process rule; a sales order
  // by its own function's rule, which is why the target arrives through a
  // join rather than as a single scalar. Both read their working day from the
  // calendar their own rules are configured against.
  const isPo = process === 'PURCHASE_ORDER';
  const withClock = isPo
    ? `WITH ${PO_CAL_CTE},
    d AS (SELECT src.*, cal.target AS rule_target, ${WORKING_MINUTES} AS acc
            FROM (${sourceFor(process)}) src CROSS JOIN cal),`
    : `WITH ${SO_CAL_CTE},
    ${SO_RULES_CTE},
    d AS (SELECT src.*, ru.target AS rule_target, ${WORKING_MINUTES} AS acc
            FROM (${sourceFor(process)}) src
            CROSS JOIN cal
            LEFT JOIN rules ru ON ru.stage = ${LA_STAGE_OF}),`;
  // The measure is the clock the figure was read on. Everything downstream —
  // the rank, the median marker, the tail index, the breach test and the
  // order — reads this one expression, so they cannot disagree with it.
  const measure = clock === 'WORKING' ? 'd.acc' : 'd.minutes';

  const ranked = `
    ${withClock}
    ranked AS (
      SELECT d.*,
             ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${measure}) AS rn,
             COUNT(*) OVER (PARTITION BY ${partition}) AS n
        FROM d WHERE ${measure} IS NOT NULL
    )
    SELECT ranked.*,
           CASE WHEN ranked.rn IN ((ranked.n + 1) / 2, (ranked.n + 2) / 2) THEN 1 ELSE 0 END
             AS is_median
      FROM ranked
     WHERE ${everyFunction ? '1 = 1' : 'ranked.fn = :fn'}${who}${inGroup}`;

  // WHICH TARGET A BREACH IS A BREACH OF. A purchase order is judged by the
  // one active process rule, which is what the chart's count over target
  // counts; every other function keeps its own stage target. Written as one
  // expression so the list and the count cannot pick different rules.
  const ranks = measure.replace('d.', 'ranked.');
  const breachTarget = 'ranked.rule_target';
  const where =
    view === 'tail'
      ? ' AND ranked.rn >= (ranked.n * 9 + 9) / 10'
      : view === 'breaches'
        ? ` AND ${breachTarget} IS NOT NULL AND ${ranks} > ${breachTarget}`
        : '';
  // The tail and the breaches read slowest first, because the question each
  // answers is which orders they are. Everything else reads fastest first, so
  // the median marker sits where a reader expects to find it.
  const order =
    view === 'tail' || view === 'breaches' ? ` ORDER BY ${ranks} DESC` : ` ORDER BY ${ranks}`;

  const found = await db.execute({ sql: `${ranked}${where}${order}`, args });
  return rowsOf(found).map((row) => toRecord(row, num(row.is_median) === 1));
}

function toRecord(row: Record<string, unknown>, isMedian: boolean): ApprovalRecord {
  const minutes = maybe(row.minutes);
  const working = maybe(row.acc);
  const ruleTarget = maybe(row.rule_target);
  // A RULE JUDGES ITS OWN CLOCK. Where the purchase order rule resolves, the
  // verdict is the working-day duration against the rule's target, because
  // that is what the rule measures. Everything else keeps the stage target
  // against the wall clock, which is what it has always measured.
  const target = ruleTarget ?? maybe(row.target_minutes);
  const judged = ruleTarget === null ? minutes : working;
  return {
    entityId: maybeText(row.entity_id),
    documentNumber: maybeText(row.document_number),
    fn: text(row.fn),
    person: maybeText(row.person),
    userId: maybeText(row.user_id),
    startedAt: maybeText(row.started_at),
    completedAt: maybeText(row.completed_at),
    minutes,
    workingMinutes: working,
    targetMinutes: target,
    ruleTargetMinutes: ruleTarget,
    withinTarget: target === null || judged === null ? null : judged <= target,
    isMedian,
  };
}

/* -------------------------------------------------------------------------
 * THE PURCHASE ORDER CHART: ONE ROW PER APPROVER, PRODUCTS BENEATH
 * ------------------------------------------------------------------------- */

/**
 * The one purchase order approval target, as the operator's SLA script set
 * it: the active PURCHASE_ORDER rule, with the calendar window it counts.
 *
 * READ, NEVER HARD-CODED. Where no active rule exists this returns null, the
 * chart draws no line and colours no bar, and the page says so in one line —
 * there is nothing to be over, and a missing target must not be able to look
 * like a met one.
 */
export interface PoApprovalRule {
  readonly ruleId: string;
  readonly targetMinutes: number;
  readonly warningMinutes: number | null;
  readonly businessHoursOnly: boolean;
  /** "08:00" / "17:00", from the rule's own calendar. */
  readonly workdayStart: string;
  readonly workdayEnd: string;
}

/** The one active rule, chosen once and reused by every expression below. */
const PO_RULE_PICK = `FROM sla_rules r
   WHERE r.entity_type = 'PURCHASE_ORDER' AND r.active = 1
   ORDER BY r.sla_rule_id LIMIT 1`;

const PO_RULE_SQL = `
  SELECT r.sla_rule_id, r.target_minutes, r.warning_minutes, r.business_hours_only,
         c.workday_start, c.workday_end
    FROM sla_rules r
    JOIN business_calendars c ON c.business_calendar_id = r.business_calendar_id
   WHERE r.entity_type = 'PURCHASE_ORDER' AND r.active = 1
   ORDER BY r.sla_rule_id LIMIT 1`;

export async function poApprovalRule(db: Client): Promise<PoApprovalRule | null> {
  const found = await db.execute(PO_RULE_SQL);
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    ruleId: text(row.sla_rule_id),
    targetMinutes: num(row.target_minutes),
    warningMinutes: maybe(row.warning_minutes),
    businessHoursOnly: num(row.business_hours_only) === 1,
    workdayStart: text(row.workday_start),
    workdayEnd: text(row.workday_end),
  };
}

/**
 * One row of the chart, at either grain.
 *
 * ONE CLOCK ON THE PANEL, AND IT IS THE ONE THE RULE MEASURES. The rule sets
 * business_hours_only on an 08:00–17:00 calendar, so `minutes` here counts
 * only time inside the working day. The wall clock is not carried to the
 * panel at all: it lives in the drill-down, beside this one and labelled,
 * where a reader who wants it has asked for it.
 *
 * `overTarget` is an absolute count against `volume` — `13 / 16`, never a
 * percentage, because 5 of 5 and 13 of 16 are different claims a rate blurs.
 */
export interface ApproverStat {
  readonly userId: string | null;
  /** Null where the extract's approver was never mapped to a person. */
  readonly person: string | null;
  /** Null on a person row; the product group on a product row. */
  readonly group: string | null;
  readonly volume: number;
  /** The median inside the working day. Null where no rule resolves. */
  readonly medianMinutes: number | null;
  /** How many exceeded the target. Zero where no rule resolves. */
  readonly overTarget: number;
  /** Past the warning but inside the target: the third bar state. */
  readonly atRisk: number;
}

export interface ApproverBoard {
  /** One row per approver, slowest first. */
  readonly people: ApproverStat[];
  /** The product groups behind each person, keyed by user id, slowest first. */
  readonly groups: ReadonlyMap<string, ApproverStat[]>;
}

/**
 * The clock inside the working day, in SQL: minutes between two stamps that
 * fall within the rule's window. Each stamp is clamped into [start, end] of
 * its own day; whole days between contribute one window each. The window
 * arrives from the active rule's calendar, so a change to the calendar
 * reaches this figure with no code change — and with NO rule the window is
 * null and so is every figure computed from it, which is the honest answer.
 */
const clampSql = (stamp: string, cal = 'cal'): string =>
  `MIN(MAX(CAST(strftime('%H', ${stamp}) AS INTEGER) * 60
           + CAST(strftime('%M', ${stamp}) AS INTEGER) - ${cal}.s, 0), ${cal}.w)`;

/** The working-day duration of one row of a source aliased `src`. */
const WORKING_CALC = `
  CAST(ROUND(julianday(date(src.completed_at)) - julianday(date(src.started_at)))
       AS INTEGER) * cal.w
  + ${clampSql('src.completed_at')} - ${clampSql('src.started_at')}`;

/** Null where no rule configures a window, because there is none to count. */
const WORKING_MINUTES = `CASE WHEN cal.s IS NULL THEN NULL ELSE ${WORKING_CALC} END`;

/**
 * THE CLOCK THE PANEL PLOTS, WHICH IS ONE CLOCK OR THE OTHER AND NEVER A
 * BLEND OF THEM. Where the rule configures a working day, every figure on
 * the panel is minutes inside it, because that is what the target judges.
 * Where no rule resolves there is no window to count inside and nothing to
 * be over, so the panel falls back to the wall clock WHOLESALE — every
 * figure, the axis and the drill-downs together — and its definition control
 * says which clock it is showing. What must never happen is one figure on
 * one clock beside another figure on the other.
 */
const PANEL_MINUTES = `CASE WHEN cal.s IS NULL THEN src.minutes ELSE ${WORKING_CALC} END`;

/**
 * The active rule as four scalars, for any statement that needs them.
 *
 * Written once and used by both the board and the record lists, so a figure
 * and the list behind it cannot end up judging against different windows.
 */
const PO_CAL_CTE = `
  cal AS (
    SELECT (SELECT CAST(substr(c.workday_start, 1, 2) AS INTEGER) * 60
                   + CAST(substr(c.workday_start, 4, 2) AS INTEGER)
              FROM sla_rules r
              JOIN business_calendars c ON c.business_calendar_id = r.business_calendar_id
             WHERE r.entity_type = 'PURCHASE_ORDER' AND r.active = 1
             ORDER BY r.sla_rule_id LIMIT 1) AS s,
           (SELECT (CAST(substr(c.workday_end, 1, 2) AS INTEGER) * 60
                    + CAST(substr(c.workday_end, 4, 2) AS INTEGER))
                   - (CAST(substr(c.workday_start, 1, 2) AS INTEGER) * 60
                      + CAST(substr(c.workday_start, 4, 2) AS INTEGER))
              FROM sla_rules r
              JOIN business_calendars c ON c.business_calendar_id = r.business_calendar_id
             WHERE r.entity_type = 'PURCHASE_ORDER' AND r.active = 1
             ORDER BY r.sla_rule_id LIMIT 1) AS w,
           (SELECT r.target_minutes ${PO_RULE_PICK}) AS target,
           (SELECT r.warning_minutes ${PO_RULE_PICK}) AS warning
  )`;

/**
 * BOTH GRAINS IN ONE STATEMENT, because Home's budget is measured in round
 * trips and expanding a person must not cost one. The person grain is
 * computed over ALL of that person's approvals — never as a median of the
 * three product medians, which is a different and wrong number.
 */
const APPROVER_BOARD_SQL = `
  WITH ${PO_CAL_CTE},
  d AS (
    SELECT src.*, cal.target AS rule_target, cal.warning AS rule_warning,
           ${PANEL_MINUTES} AS acc
      FROM (${PO_SOURCE}) src CROSS JOIN cal
     WHERE src.minutes IS NOT NULL
  ),
  ranked AS (
    SELECT d.*,
           ROW_NUMBER() OVER (PARTITION BY d.user_id ORDER BY d.acc) AS p1,
           COUNT(*) OVER (PARTITION BY d.user_id) AS n1,
           ROW_NUMBER() OVER (PARTITION BY d.user_id, d.grp ORDER BY d.acc) AS p2,
           COUNT(*) OVER (PARTITION BY d.user_id, d.grp) AS n2
      FROM d
  )
  SELECT 0 AS is_group, ranked.user_id, MAX(ranked.person) AS person, NULL AS grp,
         COUNT(*) AS volume,
         AVG(CASE WHEN ranked.p1 IN ((ranked.n1 + 1) / 2, (ranked.n1 + 2) / 2)
                  THEN ranked.acc END) AS median_minutes,
         SUM(CASE WHEN ranked.rule_target IS NOT NULL AND ranked.acc IS NOT NULL
                   AND ranked.acc > ranked.rule_target THEN 1 ELSE 0 END) AS over_target,
         SUM(CASE WHEN ranked.rule_target IS NOT NULL AND ranked.rule_warning IS NOT NULL
                   AND ranked.acc IS NOT NULL AND ranked.acc > ranked.rule_warning
                   AND ranked.acc <= ranked.rule_target THEN 1 ELSE 0 END) AS at_risk
    FROM ranked
   GROUP BY ranked.user_id

  UNION ALL

  SELECT 1 AS is_group, ranked.user_id, MAX(ranked.person) AS person, ranked.grp,
         COUNT(*) AS volume,
         AVG(CASE WHEN ranked.p2 IN ((ranked.n2 + 1) / 2, (ranked.n2 + 2) / 2)
                  THEN ranked.acc END) AS median_minutes,
         SUM(CASE WHEN ranked.rule_target IS NOT NULL AND ranked.acc IS NOT NULL
                   AND ranked.acc > ranked.rule_target THEN 1 ELSE 0 END) AS over_target,
         SUM(CASE WHEN ranked.rule_target IS NOT NULL AND ranked.rule_warning IS NOT NULL
                   AND ranked.acc IS NOT NULL AND ranked.acc > ranked.rule_warning
                   AND ranked.acc <= ranked.rule_target THEN 1 ELSE 0 END) AS at_risk
    FROM ranked
   GROUP BY ranked.user_id, ranked.grp`;

/**
 * The chart's data: one row per approver, with their product groups behind
 * them, both ordered slowest first because the reader wants the problem at
 * the top.
 *
 * THE PERSON'S FIGURE IS A TRUE MEDIAN OVER ALL THEIR APPROVALS, not a
 * volume-weighted mean of their product medians. Both are defensible; this
 * one is the same KIND of number as the rows beneath it, and — the deciding
 * argument — it is a number that exists in the list the figure opens. The
 * `typical` destination marks the row the median was read at, so a reader who
 * clicks 29 min finds the 29-minute record marked. A weighted mean of medians
 * lands between records and would mark none of them.
 */
export async function approverBoard(db: Client, scope: ApprovalScope): Promise<ApproverBoard> {
  const found = await db.execute({ sql: APPROVER_BOARD_SQL, args: windowArgs(scope) });
  const toStat = (row: Record<string, unknown>): ApproverStat => ({
    userId: maybeText(row.user_id),
    person: maybeText(row.person),
    group: maybeText(row.grp),
    volume: num(row.volume),
    medianMinutes: maybe(row.median_minutes),
    overTarget: num(row.over_target),
    atRisk: num(row.at_risk),
  });
  const all = rowsOf(found).map(toStat);
  // Slowest first, with the breach count and then the name breaking ties, so
  // the order is stable rather than incidental.
  const slowestFirst = (a: ApproverStat, b: ApproverStat) =>
    (b.medianMinutes ?? -1) - (a.medianMinutes ?? -1) ||
    b.overTarget - a.overTarget ||
    (a.person ?? '~').localeCompare(b.person ?? '~');
  const people = all.filter((row) => row.group === null).sort(slowestFirst);
  const groups = new Map<string, ApproverStat[]>();
  for (const row of all) {
    if (row.group === null) continue;
    const key = row.userId ?? '';
    groups.set(key, [...(groups.get(key) ?? []), row].sort(slowestFirst));
  }
  return { people, groups };
}

export { TARGET_SQL };

/* -------------------------------------------------------------------------
 * THE LOADING AUTHORITY PANEL: THREE FUNCTIONS, EACH WITH ITS OWN TARGET
 * ------------------------------------------------------------------------- */

/**
 * The three functions on the panel, and the rule each is judged by.
 *
 * THE MAPPING LIVES HERE AND NOWHERE ELSE. A function's workflow stage and
 * its SLA rule's stage code are NOT the same string — credit release runs on
 * the CREDIT_CHECK stage and is judged by the CREDIT_APPROVAL rule — and the
 * existing per-stage lookup, which joins the two on equality, therefore
 * resolves no target for credit at all. Written out, the pairing is a fact
 * anyone can check rather than a coincidence of naming.
 *
 * `key` is the function as the source expression names it, so it is what
 * travels in a drill-down URL; `label` is what the panel prints.
 */
export const LOADING_AUTHORITY_FUNCTIONS = [
  { key: 'Finance approval', label: 'Finance', stage: 'FINANCE_APPROVAL' },
  { key: 'Credit release', label: 'Credit', stage: 'CREDIT_APPROVAL' },
  { key: 'Loading authority', label: 'Loading authority', stage: 'LOADING_AUTHORITY' },
] as const;

export type LoadingAuthorityFunction = (typeof LOADING_AUTHORITY_FUNCTIONS)[number];

/** One row of the panel, at either grain. */
export interface LaStat {
  /** The function as the source names it, which is what a drill-down carries. */
  readonly fn: string;
  /** Null on a function row; the approver on a person row. */
  readonly userId: string | null;
  /** Null where the extract records no actor — loading authority, today. */
  readonly person: string | null;
  /** True on a person row, so a null person is "Not recorded" and not a total. */
  readonly isPerson: boolean;
  readonly volume: number;
  /** The median inside the working day. */
  readonly medianMinutes: number | null;
  /** This function's own target, read from its own rule. Null where none. */
  readonly targetMinutes: number | null;
  readonly warningMinutes: number | null;
  /** How many exceeded that target. Meaningless, and zero, without one. */
  readonly overTarget: number;
  readonly atRisk: number;
}

/** One country's tab, and whether it can be selected. */
export interface LaCountry {
  readonly affiliateId: string;
  /**
   * THE ABBREVIATION THE TAB DRAWS, read from `affiliates.affiliate_code`.
   * Eight full names do not fit on a panel and repeat the same two words
   * eight times; the code is three characters and the name is still one
   * hover or one screen reader away.
   */
  readonly code: string;
  readonly name: string;
  /** Completions in the active period. A country with none is greyed, not hidden. */
  readonly volume: number;
}

/** One country's panel: the three functions and the approvers behind them. */
export interface LaCountryBoard {
  readonly functions: LaStat[];
  /** The approvers behind each function, keyed by the function's own name. */
  readonly people: ReadonlyMap<string, LaStat[]>;
}

export interface LoadingAuthorityBoard {
  /**
   * EVERY COUNTRY'S PANEL, FROM ONE STATEMENT. The tabs cannot be chosen
   * before the query runs — which country to select depends on which have
   * data — so the query answers for all of them and the page picks. Eight
   * countries times three functions is a handful of rows, and it costs the
   * page nothing: switching tabs is a link, not a request for more data.
   */
  readonly byCountry: ReadonlyMap<string, LaCountryBoard>;
  readonly countries: LaCountry[];
  /** Functions with no active rule, so the page can offer to set one. */
  readonly missingTargets: string[];
  /** Each function's target, whether or not any country ran it this period. */
  readonly targets: ReadonlyMap<string, { target: number | null; warning: number | null }>;
}

/** The three functions, unscoped by affiliate: the tabs need every country. */
const LA_SOURCE = [
  soStage('Finance approval', 1, 'FINANCE_APPROVAL', false),
  soStage('Credit release', 2, 'CREDIT_CHECK', false),
  soOrder('Loading authority', 4, 'loading_authority_at', LOADING_AUTHORITY_START, false),
].join('\n\n  UNION ALL\n');

/** Which rule judges which function, as a CASE over the source's own names. */
const LA_STAGE_OF = `CASE src.fn ${LOADING_AUTHORITY_FUNCTIONS.map(
  (f) => `WHEN '${f.key}' THEN '${f.stage}'`,
).join(' ')} END`;

/**
 * The sales order working day, from the calendar its active rules are set
 * against — ONE window for the whole process, so three functions can be read
 * on one scale. Null where no rule is active at all, which makes every
 * working-day figure null and sends the panel to the wall clock wholesale
 * rather than mixing two clocks on one axis.
 */
const SO_CAL_CTE = `
  cal AS (
    SELECT (SELECT CAST(substr(c.workday_start, 1, 2) AS INTEGER) * 60
                   + CAST(substr(c.workday_start, 4, 2) AS INTEGER)
              FROM sla_rules r
              JOIN business_calendars c ON c.business_calendar_id = r.business_calendar_id
             WHERE r.entity_type = 'SALES_ORDER' AND r.active = 1
             ORDER BY r.sla_rule_id LIMIT 1) AS s,
           (SELECT (CAST(substr(c.workday_end, 1, 2) AS INTEGER) * 60
                    + CAST(substr(c.workday_end, 4, 2) AS INTEGER))
                   - (CAST(substr(c.workday_start, 1, 2) AS INTEGER) * 60
                      + CAST(substr(c.workday_start, 4, 2) AS INTEGER))
              FROM sla_rules r
              JOIN business_calendars c ON c.business_calendar_id = r.business_calendar_id
             WHERE r.entity_type = 'SALES_ORDER' AND r.active = 1
             ORDER BY r.sla_rule_id LIMIT 1) AS w
  )`;

/**
 * EACH FUNCTION'S OWN TARGET, one row per stage code. Finance and credit
 * share a value today and that is a coincidence of configuration: they are
 * read separately, so changing one never moves the other.
 */
const SO_RULES_CTE = `
  rules AS (
    SELECT r.stage_code AS stage, MIN(r.target_minutes) AS target,
           MIN(r.warning_minutes) AS warning
      FROM sla_rules r
     WHERE r.entity_type = 'SALES_ORDER' AND r.active = 1 AND r.stage_code IS NOT NULL
     GROUP BY r.stage_code
  )`;

/**
 * ONE WINDOW FOR THE PANEL, ONE TARGET PER FUNCTION, AND THEY ARE DIFFERENT
 * THINGS.
 *
 * The working day comes from the CALENDAR the active rules are configured
 * against, so every figure on the panel is measured the same way and the
 * three functions can be read on one scale. The TARGET comes from each
 * function's own rule, so finance and credit sharing 30 minutes today is a
 * coincidence of configuration rather than a rule of the code: change one and
 * the other does not move.
 *
 * Where a function has no active rule it keeps its duration and loses its
 * verdict — grey, unjudged, no count. Where NO rule is active at all there is
 * no calendar to read a working day from, so the panel measures the wall
 * clock wholesale, exactly as the purchase order panel does, rather than
 * mixing two clocks on one axis.
 */
const LA_BOARD_SQL = `
  WITH ${SO_CAL_CTE},
  ${SO_RULES_CTE},
  d AS (
    SELECT src.*, ru.target AS target, ru.warning AS warning,
           CASE WHEN cal.s IS NULL THEN src.minutes
                ELSE CAST(ROUND(julianday(date(src.completed_at))
                                - julianday(date(src.started_at))) AS INTEGER) * cal.w
                     + ${clampSql('src.completed_at')} - ${clampSql('src.started_at')} END AS acc
      FROM (${LA_SOURCE}) src
      CROSS JOIN cal
      LEFT JOIN rules ru ON ru.stage = ${LA_STAGE_OF}
     WHERE src.minutes IS NOT NULL
  ),
  ranked AS (
    SELECT d.*,
           ROW_NUMBER() OVER (PARTITION BY d.affiliate_id, d.fn ORDER BY d.acc) AS f1,
           COUNT(*) OVER (PARTITION BY d.affiliate_id, d.fn) AS n1,
           ROW_NUMBER() OVER (
             PARTITION BY d.affiliate_id, d.fn, d.user_id ORDER BY d.acc) AS p2,
           COUNT(*) OVER (PARTITION BY d.affiliate_id, d.fn, d.user_id) AS n2
      FROM d
  )
  SELECT 0 AS grain, ranked.fn, NULL AS user_id, NULL AS person,
         ranked.affiliate_id AS affiliate_id, NULL AS affiliate_name,
         COUNT(*) AS volume,
         AVG(CASE WHEN ranked.f1 IN ((ranked.n1 + 1) / 2, (ranked.n1 + 2) / 2)
                  THEN ranked.acc END) AS median_minutes,
         MIN(ranked.target) AS target, MIN(ranked.warning) AS warning,
         SUM(CASE WHEN ranked.target IS NOT NULL AND ranked.acc IS NOT NULL
                   AND ranked.acc > ranked.target THEN 1 ELSE 0 END) AS over_target,
         SUM(CASE WHEN ranked.target IS NOT NULL AND ranked.warning IS NOT NULL
                   AND ranked.acc IS NOT NULL AND ranked.acc > ranked.warning
                   AND ranked.acc <= ranked.target THEN 1 ELSE 0 END) AS at_risk
    FROM ranked GROUP BY ranked.affiliate_id, ranked.fn

  UNION ALL

  SELECT 1 AS grain, ranked.fn, ranked.user_id, MAX(ranked.person) AS person,
         ranked.affiliate_id AS affiliate_id, NULL AS affiliate_name,
         COUNT(*) AS volume,
         AVG(CASE WHEN ranked.p2 IN ((ranked.n2 + 1) / 2, (ranked.n2 + 2) / 2)
                  THEN ranked.acc END) AS median_minutes,
         MIN(ranked.target) AS target, MIN(ranked.warning) AS warning,
         SUM(CASE WHEN ranked.target IS NOT NULL AND ranked.acc IS NOT NULL
                   AND ranked.acc > ranked.target THEN 1 ELSE 0 END) AS over_target,
         SUM(CASE WHEN ranked.target IS NOT NULL AND ranked.warning IS NOT NULL
                   AND ranked.acc IS NOT NULL AND ranked.acc > ranked.warning
                   AND ranked.acc <= ranked.target THEN 1 ELSE 0 END) AS at_risk
    FROM ranked GROUP BY ranked.affiliate_id, ranked.fn, ranked.user_id

  UNION ALL

  -- EVERY COUNTRY, WHETHER OR NOT IT HAS ANYTHING. A tab that is missing
  -- tells a reader nothing; a tab that is present and greyed tells them the
  -- country exists and this month is empty, which is the information.
  SELECT 2 AS grain, NULL AS fn, a.affiliate_code AS user_id, NULL AS person,
         a.affiliate_id AS affiliate_id, a.affiliate_name AS affiliate_name,
         (SELECT COUNT(*) FROM d WHERE d.affiliate_id = a.affiliate_id) AS volume,
         NULL AS median_minutes, NULL AS target, NULL AS warning,
         0 AS over_target, 0 AS at_risk
    FROM affiliates a
   WHERE a.active = 1

  UNION ALL

  -- THE TARGETS THEMSELVES, INDEPENDENT OF THE DATA. A function's target is
  -- a property of its rule; reading it off the completions made a month with
  -- no orders look like a month with no target, which is the confusion
  -- between zero and unknown this panel exists to keep apart.
  SELECT 3 AS grain, ru.stage AS fn, NULL AS user_id, NULL AS person,
         NULL AS affiliate_id, NULL AS affiliate_name, 0 AS volume,
         NULL AS median_minutes, ru.target AS target, ru.warning AS warning,
         0 AS over_target, 0 AS at_risk
    FROM rules ru`;

/**
 * The panel's data: three functions, their approvers, and every country's tab,
 * in ONE statement — because Home's budget is counted in round trips and a
 * panel is not allowed to cost more of them than the chart it replaced.
 */
export async function loadingAuthorityBoard(
  db: Client,
  scope: ApprovalScope,
): Promise<LoadingAuthorityBoard> {
  // THE PERIOD ONLY. The affiliate is not bound here and that is deliberate:
  // the tabs need every country's figures from one statement, so the country
  // is chosen from the result rather than pushed into the query. A parameter
  // a statement never mentions is refused by the driver, so it is not sent.
  const found = await db.execute({
    sql: LA_BOARD_SQL,
    args: { from: scope.from, to: scope.to },
  });
  const rows = rowsOf(found);
  const toStat = (row: Record<string, unknown>, isPerson: boolean): LaStat => ({
    fn: text(row.fn),
    userId: maybeText(row.user_id),
    person: maybeText(row.person),
    isPerson,
    volume: num(row.volume),
    medianMinutes: maybe(row.median_minutes),
    targetMinutes: maybe(row.target),
    warningMinutes: maybe(row.warning),
    overTarget: num(row.over_target),
    atRisk: num(row.at_risk),
  });

  // EVERY FUNCTION'S TARGET, WHETHER OR NOT IT RAN. A function with no
  // completions this month still has a rule and still draws its line; a
  // target that appeared only where there was data would vanish exactly when
  // a reader wanted to know what the empty month was measured against.
  const targets = new Map<string, { target: number | null; warning: number | null }>();
  for (const f of LOADING_AUTHORITY_FUNCTIONS) targets.set(f.key, { target: null, warning: null });
  const byStage = new Map(
    rows.filter((row) => num(row.grain) === 3).map((row) => [text(row.fn), row] as const),
  );
  for (const f of LOADING_AUTHORITY_FUNCTIONS) {
    const rule = byStage.get(f.stage);
    if (rule === undefined) continue;
    targets.set(f.key, { target: maybe(rule.target), warning: maybe(rule.warning) });
  }

  const slowestFirst = (a: LaStat, b: LaStat) =>
    (b.medianMinutes ?? -1) - (a.medianMinutes ?? -1) ||
    b.overTarget - a.overTarget ||
    (a.person ?? '~').localeCompare(b.person ?? '~');

  const functionRows = new Map<string, Map<string, LaStat>>();
  const peopleRows = new Map<string, Map<string, LaStat[]>>();
  for (const row of rows) {
    const grain = num(row.grain);
    if (grain === 2 || grain === 3) continue;
    const country = text(row.affiliate_id);
    if (grain === 0) {
      const forCountry = functionRows.get(country) ?? new Map<string, LaStat>();
      forCountry.set(text(row.fn), toStat(row, false));
      functionRows.set(country, forCountry);
      continue;
    }
    const forCountry = peopleRows.get(country) ?? new Map<string, LaStat[]>();
    const key = text(row.fn);
    forCountry.set(key, [...(forCountry.get(key) ?? []), toStat(row, true)]);
    peopleRows.set(country, forCountry);
  }

  const countries = rows
    .filter((row) => num(row.grain) === 2)
    .map(
      (row): LaCountry => ({
        affiliateId: text(row.affiliate_id),
        // Carried in the user_id column because every arm of a UNION must
        // agree on its columns, and this arm has no person to name.
        code: text(row.user_id),
        name: text(row.affiliate_name),
        volume: num(row.volume),
      }),
    )
    .sort((a, b) => a.code.localeCompare(b.code));

  const byCountry = new Map<string, LaCountryBoard>();
  for (const country of countries) {
    const found0 = functionRows.get(country.affiliateId) ?? new Map<string, LaStat>();
    const people = new Map<string, LaStat[]>();
    for (const [key, list] of peopleRows.get(country.affiliateId) ?? []) {
      people.set(key, [...list].sort(slowestFirst));
    }
    // EVERY CONFIGURED FUNCTION APPEARS, WHETHER OR NOT IT RAN. A function
    // that did nothing this month is a fact a reader can act on; a function
    // missing from the panel reads as one that does not exist.
    const withTarget = (row: LaStat, key: string): LaStat => ({
      ...row,
      targetMinutes: targets.get(key)?.target ?? null,
      warningMinutes: targets.get(key)?.warning ?? null,
    });
    const functions = LOADING_AUTHORITY_FUNCTIONS.map((f): LaStat => {
      const found = found0.get(f.key);
      return found === undefined
        ? {
            fn: f.key,
            userId: null,
            person: null,
            isPerson: false,
            volume: 0,
            medianMinutes: null,
            targetMinutes: targets.get(f.key)?.target ?? null,
            warningMinutes: targets.get(f.key)?.warning ?? null,
            overTarget: 0,
            atRisk: 0,
          }
        : withTarget(found, f.key);
    });
    for (const [key, list] of people) {
      people.set(
        key,
        list.map((row) => withTarget(row, key)),
      );
    }
    byCountry.set(country.affiliateId, { functions, people });
  }

  return {
    byCountry,
    countries,
    targets,
    missingTargets: LOADING_AUTHORITY_FUNCTIONS.filter(
      (f) => (targets.get(f.key)?.target ?? null) === null,
    ).map((f) => f.key),
  };
}
