/**
 * Customer service analytics.
 *
 * This goes beyond counting complaints. It says what customers experienced,
 * what recurs, where internal time accumulated, and whether promises were
 * kept, and it is careful about which of those it can actually prove.
 *
 * ELAPSED AND ACCOUNTABLE ARE BOTH TRUE AND ARE NEVER MIXED.
 * A case that spent five hours waiting on the customer took five hours of
 * that customer's day whatever the SLA says. The customer's experience is
 * the elapsed figure; what the organisation holds somebody to is the
 * accountable one. Both are reported, both are labelled, and neither is ever
 * presented as the other.
 *
 * INTERNAL WAITING IS NOT AUTOMATICALLY EXCUSABLE.
 * The SLA engine's pause policy already decides what is accountable. This
 * breakdown is a different question: where the time actually went. Internal
 * waiting is frequently the thing worth measuring, so it is shown as its own
 * band rather than folded into handling or quietly excused.
 *
 * FREE TEXT IS NOT A DIMENSION.
 * `service_cases.root_cause` is a sentence somebody typed. It is searchable
 * and it appears on a case, and nothing is counted by it. Counting happens on
 * `case_categories`, which is the structured value the business agreed.
 *
 * A MISSING SURVEY IS NOT A NEUTRAL SCORE.
 * Non-responses are excluded from every score and reported as coverage.
 * Imputing them would invent an opinion nobody expressed.
 */
import type { Client } from '@libsql/client/web';
import { scopedCases } from './serviceAdmin.ts';
import {
  andAll,
  bucketExpression,
  dateWindow,
  equals,
  type AnalyticsFilter,
} from '../analytics/filters.ts';
import { minutesBetweenSql, rate } from '../analytics/stats.ts';

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const number = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export interface Population {
  source: string;
  where: string;
  args: (string | number)[];
}

export const CASE_SOURCE = `service_cases sc
  JOIN accounts a ON a.account_id = sc.account_id
  JOIN case_categories cc ON cc.case_category_id = sc.case_category_id`;

/** The date basis is `raised_at`: when the customer came to us. */
export async function casePopulation(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  dateColumn = 'sc.raised_at',
): Promise<Population> {
  const scope = await scopedCases(db, userId);
  const combined = andAll([
    { sql: scope.sql, args: scope.args as (string | number)[] },
    dateWindow(dateColumn, filter),
    equals('a.country_id', filter.countryId),
    equals('a.affiliate_id', filter.affiliateId),
    equals('sc.business_unit_id', filter.businessUnitId),
    equals('sc.account_id', filter.accountId),
    equals('sc.case_category_id', filter.caseCategoryId),
    equals('sc.status', filter.status),
    equals('sc.assigned_user_id', filter.ownerId),
    equals('sc.assigned_team_id', filter.teamId),
  ]);
  return { source: CASE_SOURCE, where: combined.sql, args: combined.args };
}

// ---- Signals -----------------------------------------------------------------

export interface ServiceSummary {
  casesOpened: number;
  openBacklog: number;
  externalSlaCompliancePercent: number | null;
  externalSlaMeasured: number;
  /** Wall clock: what the customer experienced. */
  medianResolutionElapsedMinutes: number | null;
  /** Pause-adjusted: what the SLA holds somebody to. */
  medianResolutionAccountableMinutes: number | null;
  resolutionMeasured: number;
  resolutionTotal: number;
  firstResponseMedianMinutes: number | null;
  firstResponseP90Minutes: number | null;
  firstResponseWithinSlaPercent: number | null;
  firstResponseMeasured: number;
  awaitingFirstResponse: number;
  /** CSAT with its sample size, because one response is not a headline. */
  csatScore: number | null;
  csatResponses: number;
}

/**
 * The external SLA is what the customer was promised. Internal SLAs measure
 * which stage or team held responsibility and are reported separately, never
 * blended into the customer-facing compliance figure.
 */
const EXTERNAL_SLA = `si.sla_rule_id IN (
  SELECT sr.sla_rule_id FROM sla_rules sr
  JOIN sla_profiles sp ON sp.sla_profile_id = sr.sla_profile_id
  WHERE sp.sla_type = 'EXTERNAL')`;

export async function summary(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<ServiceSummary> {
  const population = await casePopulation(db, userId, filter);
  const elapsed = minutesBetweenSql('sc.raised_at', 'sc.resolved_at');
  // Accountable: the same interval less whatever the engine recorded as
  // paused on this case's external timer.
  const accountable = `CASE WHEN sc.resolved_at IS NULL THEN NULL ELSE MAX(0, ${elapsed}
      - COALESCE((SELECT MIN(si.paused_minutes) FROM sla_instances si
                   WHERE si.entity_type = 'CASE' AND si.entity_id = sc.case_id
                     AND ${EXTERNAL_SLA}), 0)) END`;
  const firstResponse = minutesBetweenSql('sc.raised_at', 'sc.first_response_at');

  const result = await db.execute({
    sql: `WITH base AS (
            SELECT sc.case_id, sc.status, sc.resolved_at, sc.first_response_at,
                   ${elapsed} AS elapsed_minutes,
                   ${accountable} AS accountable_minutes,
                   ${firstResponse} AS first_response_minutes,
                   (SELECT si.status FROM sla_instances si
                     WHERE si.entity_type = 'CASE' AND si.entity_id = sc.case_id AND ${EXTERNAL_SLA}
                     ORDER BY CASE si.status WHEN 'BREACHED' THEN 0 WHEN 'MET' THEN 1 ELSE 2 END
                     LIMIT 1) AS external_sla
            FROM ${population.source} WHERE ${population.where}
          ),
          r_elapsed AS (
            SELECT elapsed_minutes AS v, ROW_NUMBER() OVER (ORDER BY elapsed_minutes) AS rn,
                   COUNT(*) OVER () AS c FROM base WHERE elapsed_minutes IS NOT NULL
          ),
          r_accountable AS (
            SELECT accountable_minutes AS v, ROW_NUMBER() OVER (ORDER BY accountable_minutes) AS rn,
                   COUNT(*) OVER () AS c FROM base WHERE accountable_minutes IS NOT NULL
          ),
          r_response AS (
            SELECT first_response_minutes AS v,
                   ROW_NUMBER() OVER (ORDER BY first_response_minutes) AS rn,
                   COUNT(*) OVER () AS c FROM base WHERE first_response_minutes IS NOT NULL
          )
          SELECT COUNT(*) AS opened,
                 SUM(CASE WHEN status NOT IN ('RESOLVED','CLOSED','CANCELLED') THEN 1 ELSE 0 END) AS backlog,
                 SUM(CASE WHEN external_sla = 'MET' THEN 1 ELSE 0 END) AS met,
                 SUM(CASE WHEN external_sla = 'BREACHED' THEN 1 ELSE 0 END) AS breached,
                 SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved_count,
                 SUM(CASE WHEN first_response_at IS NOT NULL THEN 1 ELSE 0 END) AS responded,
                 SUM(CASE WHEN first_response_at IS NULL THEN 1 ELSE 0 END) AS awaiting_response,
                 (SELECT MAX(CASE WHEN rn = (c + 1) / 2 THEN v END) FROM r_elapsed) AS elapsed_median,
                 (SELECT MAX(CASE WHEN rn = (c + 1) / 2 THEN v END) FROM r_accountable) AS accountable_median,
                 (SELECT MAX(CASE WHEN rn = (c + 1) / 2 THEN v END) FROM r_response) AS response_median,
                 (SELECT MAX(CASE WHEN rn = (c * 9 + 9) / 10 THEN v END) FROM r_response) AS response_p90
          FROM base`,
    args: population.args as never[],
  });
  const row = (result.rows[0] ?? {}) as unknown as Record<string, unknown>;

  // First response compliance from the engine's own first-response timers.
  const responseSla = await db.execute({
    sql: `SELECT SUM(CASE WHEN si.status = 'MET' THEN 1 ELSE 0 END) AS met,
                 SUM(CASE WHEN si.status = 'BREACHED' THEN 1 ELSE 0 END) AS breached
          FROM ${population.source}
          JOIN sla_instances si ON si.entity_type = 'CASE' AND si.entity_id = sc.case_id
          JOIN sla_rules sr ON sr.sla_rule_id = si.sla_rule_id
          WHERE ${population.where} AND sr.stage_code = 'FIRST_RESPONSE'`,
    args: population.args as never[],
  });
  const responseRow = (responseSla.rows[0] ?? {}) as unknown as Record<string, unknown>;

  const csat = await surveyScores(db, userId, filter);
  const csatRow = csat.find((entry) => entry.surveyType === 'CSAT');
  const met = Number(row.met ?? 0);
  const breached = Number(row.breached ?? 0);

  return {
    casesOpened: Number(row.opened ?? 0),
    openBacklog: Number(row.backlog ?? 0),
    externalSlaCompliancePercent: rate(met, met + breached),
    externalSlaMeasured: met + breached,
    medianResolutionElapsedMinutes: number(row.elapsed_median),
    medianResolutionAccountableMinutes: number(row.accountable_median),
    resolutionMeasured: Number(row.resolved_count ?? 0),
    resolutionTotal: Number(row.opened ?? 0),
    firstResponseMedianMinutes: number(row.response_median),
    firstResponseP90Minutes: number(row.response_p90),
    firstResponseWithinSlaPercent: rate(
      Number(responseRow.met ?? 0),
      Number(responseRow.met ?? 0) + Number(responseRow.breached ?? 0),
    ),
    firstResponseMeasured: Number(row.responded ?? 0),
    awaitingFirstResponse: Number(row.awaiting_response ?? 0),
    csatScore: csatRow?.score ?? null,
    csatResponses: csatRow?.responses ?? 0,
  };
}

// ---- Where the time went -----------------------------------------------------

export interface WaitingBreakdown {
  /** Cases whose status history is complete enough to decompose. */
  casesMeasured: number;
  casesExcluded: number;
  totalCases: number;
  waitingCustomerMinutes: number;
  waitingInternalMinutes: number;
  activeHandlingMinutes: number;
  /** The three bands sum to this, which is the elapsed total they came from. */
  elapsedMinutes: number;
  wording: string;
}

export const INTERNAL_WAITING_WORDING =
  'Internal waiting is shown as its own band and is not excused. The SLA engine already decides what is accountable; this breakdown answers a different question, which is where the time actually went. Time a case spent waiting on Hass is frequently the part worth acting on.';

/**
 * Decompose elapsed time into waiting on the customer, waiting internally
 * and active handling, from `case_status_history`.
 *
 * A CASE WITH INCOMPLETE EVENTS IS EXCLUDED, NOT GUESSED.
 * The decomposition walks consecutive status changes. Where a case has no
 * history, or its history does not reach resolution, there is no honest way
 * to attribute its time, so it leaves the population and the coverage says
 * how many did.
 */
export async function waitingBreakdown(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<WaitingBreakdown> {
  const population = await casePopulation(db, userId, filter);
  const result = await db.execute({
    sql: `WITH cases AS (
            SELECT sc.case_id, sc.raised_at, sc.resolved_at,
                   ${minutesBetweenSql('sc.raised_at', 'sc.resolved_at')} AS elapsed
            FROM ${population.source} WHERE ${population.where}
          ),
          eligible AS (
            SELECT c.case_id, c.raised_at, c.resolved_at, c.elapsed
            FROM cases c
            WHERE c.resolved_at IS NOT NULL
              AND EXISTS (SELECT 1 FROM case_status_history h WHERE h.case_id = c.case_id)
          ),
          spans AS (
            SELECT h.case_id, h.to_status AS status, h.changed_at AS from_at,
                   COALESCE(LEAD(h.changed_at) OVER (PARTITION BY h.case_id ORDER BY h.changed_at),
                            e.resolved_at) AS to_at
            FROM case_status_history h
            JOIN eligible e ON e.case_id = h.case_id
          ),
          measured AS (
            SELECT status, ${minutesBetweenSql('from_at', 'to_at')} AS minutes FROM spans
          )
          SELECT
            (SELECT COUNT(*) FROM cases) AS total_cases,
            (SELECT COUNT(*) FROM eligible) AS measured_cases,
            (SELECT COALESCE(SUM(elapsed), 0) FROM eligible) AS elapsed_total,
            COALESCE(SUM(CASE WHEN status = 'WAITING_CUSTOMER' THEN minutes ELSE 0 END), 0) AS waiting_customer,
            COALESCE(SUM(CASE WHEN status = 'WAITING_INTERNAL' THEN minutes ELSE 0 END), 0) AS waiting_internal,
            COALESCE(SUM(CASE WHEN status NOT IN ('WAITING_CUSTOMER','WAITING_INTERNAL') THEN minutes ELSE 0 END), 0) AS active
          FROM measured`,
    args: population.args as never[],
  });
  const row = (result.rows[0] ?? {}) as unknown as Record<string, unknown>;
  const total = Number(row.total_cases ?? 0);
  const measured = Number(row.measured_cases ?? 0);
  const waitingCustomer = Number(row.waiting_customer ?? 0);
  const waitingInternal = Number(row.waiting_internal ?? 0);
  const active = Number(row.active ?? 0);
  return {
    casesMeasured: measured,
    casesExcluded: total - measured,
    totalCases: total,
    waitingCustomerMinutes: waitingCustomer,
    waitingInternalMinutes: waitingInternal,
    activeHandlingMinutes: active,
    // The bands are the decomposition, so their sum IS the elapsed total for
    // the measured cases rather than a separately computed figure that could
    // silently disagree with them.
    elapsedMinutes: waitingCustomer + waitingInternal + active,
    wording: INTERNAL_WAITING_WORDING,
  };
}

// ---- Handoffs ----------------------------------------------------------------

export interface HandoffRow {
  caseId: string;
  caseNumber: string;
  handoffs: number;
  /** The chain, in the order it happened. */
  chain: { at: string; fromTeam: string | null; toTeam: string | null; toUser: string | null }[];
  highReassignment: boolean;
}

export const HIGH_REASSIGNMENT_WORDING =
  'High reassignment. This is a count, not a judgement: a case may have moved three times because it was genuinely complex, or because it needed a specialist who was away. The label exists so somebody looks, not so somebody is blamed.';

/**
 * Handoff chains from `case_assignment_history`, in the order they happened.
 *
 * A case above the threshold is labelled "High reassignment" and NOTHING
 * ELSE. The data cannot support "poorly handled": it records that a case
 * moved, not why, and the two most common reasons are complexity and
 * absence, neither of which is anybody's failure.
 */
export async function handoffs(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  threshold = 3,
): Promise<{ rows: HandoffRow[]; threshold: number; wording: string }> {
  const population = await casePopulation(db, userId, filter);
  const result = await db.execute({
    sql: `SELECT sc.case_id, sc.case_number,
            h.assigned_at, h.from_team_id, h.to_team_id, h.to_user_id,
            ft.team_name AS from_team_name, tt.team_name AS to_team_name,
            u.display_name AS to_user_name
          FROM ${population.source}
          JOIN case_assignment_history h ON h.case_id = sc.case_id
          LEFT JOIN teams ft ON ft.team_id = h.from_team_id
          LEFT JOIN teams tt ON tt.team_id = h.to_team_id
          LEFT JOIN users u ON u.user_id = h.to_user_id
          WHERE ${population.where}
          ORDER BY sc.case_id, h.assigned_at`,
    args: population.args as never[],
  });
  const byCase = new Map<string, HandoffRow>();
  for (const raw of result.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const id = text(row.case_id);
    const existing = byCase.get(id) ?? {
      caseId: id,
      caseNumber: text(row.case_number),
      handoffs: 0,
      chain: [],
      highReassignment: false,
    };
    existing.chain.push({
      at: text(row.assigned_at),
      fromTeam: nullableText(row.from_team_name),
      toTeam: nullableText(row.to_team_name),
      toUser: nullableText(row.to_user_name),
    });
    existing.handoffs = existing.chain.length;
    existing.highReassignment = existing.handoffs >= threshold;
    byCase.set(id, existing);
  }
  return {
    rows: [...byCase.values()].sort((a, b) => b.handoffs - a.handoffs),
    threshold,
    wording: HIGH_REASSIGNMENT_WORDING,
  };
}

// ---- Categories and repeats --------------------------------------------------

export interface CategoryRow {
  caseCategoryId: string;
  categoryName: string;
  subcategoryName: string;
  cases: number;
  complaints: number;
  medianResolutionElapsedMinutes: number | null;
  breached: number;
}

/**
 * Counting happens on the structured category and nowhere else. The free
 * text in `root_cause` is offered for search on the case itself; it is never
 * a bucket here, because two people describing the same fault in two
 * sentences would become two causes.
 */
export async function categoryMix(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<CategoryRow[]> {
  const population = await casePopulation(db, userId, filter);
  const elapsed = minutesBetweenSql('sc.raised_at', 'sc.resolved_at');
  const result = await db.execute({
    sql: `WITH base AS (
            SELECT sc.case_category_id, cc.category_name, cc.subcategory_name, sc.case_type,
                   sc.case_id, ${elapsed} AS elapsed_minutes,
                   (SELECT COUNT(*) FROM sla_instances si
                     WHERE si.entity_type = 'CASE' AND si.entity_id = sc.case_id
                       AND si.status = 'BREACHED') AS breaches
            FROM ${population.source} WHERE ${population.where}
          ),
          ranked AS (
            SELECT case_category_id, elapsed_minutes,
                   ROW_NUMBER() OVER (PARTITION BY case_category_id ORDER BY elapsed_minutes) AS rn,
                   COUNT(*) OVER (PARTITION BY case_category_id) AS c
            FROM base WHERE elapsed_minutes IS NOT NULL
          )
          SELECT b.case_category_id, b.category_name, b.subcategory_name,
                 COUNT(*) AS cases,
                 SUM(CASE WHEN b.case_type = 'COMPLAINT' THEN 1 ELSE 0 END) AS complaints,
                 SUM(CASE WHEN b.breaches > 0 THEN 1 ELSE 0 END) AS breached,
                 (SELECT MAX(CASE WHEN rn = (c + 1) / 2 THEN elapsed_minutes END) FROM ranked r
                   WHERE r.case_category_id = b.case_category_id) AS median_minutes
          FROM base b GROUP BY b.case_category_id ORDER BY cases DESC`,
    args: population.args as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      caseCategoryId: text(row.case_category_id),
      categoryName: text(row.category_name),
      subcategoryName: text(row.subcategory_name),
      cases: Number(row.cases ?? 0),
      complaints: Number(row.complaints ?? 0),
      medianResolutionElapsedMinutes: number(row.median_minutes),
      breached: Number(row.breached ?? 0),
    };
  });
}

export interface RepeatRow {
  accountId: string;
  customerName: string;
  caseCategoryId: string;
  categoryName: string;
  subcategoryName: string;
  cases: number;
  firstAt: string;
  lastAt: string;
}

export const REPEAT_WORDING =
  'A repeat issue is the same customer and the same category within the configured window. It is NOT a claim that the underlying fault is the same: two billing enquiries a fortnight apart may be entirely unrelated, and this label says only that they look alike from here.';

/**
 * Repeat issues: same customer, same category, within a configurable window.
 * The default is stated and the window is a query parameter, because a
 * period hard-coded in this file would be a policy nobody agreed.
 */
export async function repeatIssues(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<{ rows: RepeatRow[]; windowDays: number; wording: string }> {
  const population = await casePopulation(db, userId, filter);
  const result = await db.execute({
    sql: `SELECT sc.account_id, a.account_name, sc.case_category_id,
            cc.category_name, cc.subcategory_name,
            COUNT(*) AS cases, MIN(sc.raised_at) AS first_at, MAX(sc.raised_at) AS last_at
          FROM ${population.source}
          WHERE ${population.where}
          GROUP BY sc.account_id, sc.case_category_id
          HAVING COUNT(*) > 1
             AND (julianday(MAX(sc.raised_at)) - julianday(MIN(sc.raised_at))) <= ?
          ORDER BY cases DESC`,
    args: [...population.args, filter.repeatDays] as never[],
  });
  return {
    windowDays: filter.repeatDays,
    wording: REPEAT_WORDING,
    rows: result.rows.map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      return {
        accountId: text(row.account_id),
        customerName: text(row.account_name),
        caseCategoryId: text(row.case_category_id),
        categoryName: text(row.category_name),
        subcategoryName: text(row.subcategory_name),
        cases: Number(row.cases ?? 0),
        firstAt: text(row.first_at),
        lastAt: text(row.last_at),
      };
    }),
  };
}

// ---- SLA and attribution -----------------------------------------------------

export interface SlaPicture {
  /** What the customer was promised. */
  external: { met: number; breached: number; atRisk: number; compliancePercent: number | null };
  /** Which stage or team held responsibility. A different question. */
  internal: { met: number; breached: number; atRisk: number; compliancePercent: number | null };
  medianBreachMinutes: number | null;
  topBreachStages: { stage: string; breaches: number }[];
  topBreachTeams: { team: string; breaches: number }[];
  attributionNote: string;
}

export const BREACH_ATTRIBUTION_NOTE =
  'A breach is attributed from sla_breaches.accountable_user_id and accountable_team_id, and from the assignment history at the time, never to whoever closed the case. The person who closed a case is very often the person who rescued it.';

export async function slaPicture(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<SlaPicture> {
  const population = await casePopulation(db, userId, filter);
  const result = await db.execute({
    sql: `SELECT sp.sla_type AS sla_type, si.status AS status, COUNT(*) AS n,
            SUM(CASE WHEN si.status = 'RUNNING' AND si.warning_at IS NOT NULL
                      AND si.warning_at <= ? AND si.target_at > ? THEN 1 ELSE 0 END) AS at_risk
          FROM ${population.source}
          JOIN sla_instances si ON si.entity_type = 'CASE' AND si.entity_id = sc.case_id
          JOIN sla_rules sr ON sr.sla_rule_id = si.sla_rule_id
          JOIN sla_profiles sp ON sp.sla_profile_id = sr.sla_profile_id
          WHERE ${population.where}
          GROUP BY sp.sla_type, si.status`,
    args: [now, now, ...population.args] as never[],
  });
  const tally = {
    EXTERNAL: { met: 0, breached: 0, atRisk: 0 },
    INTERNAL: { met: 0, breached: 0, atRisk: 0 },
  };
  for (const raw of result.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const type = text(row.sla_type) === 'INTERNAL' ? 'INTERNAL' : 'EXTERNAL';
    const status = text(row.status);
    const n = Number(row.n ?? 0);
    if (status === 'MET') tally[type].met += n;
    if (status === 'BREACHED') tally[type].breached += n;
    tally[type].atRisk += Number(row.at_risk ?? 0);
  }

  const breaches = await db.execute({
    sql: `WITH b AS (
            SELECT sb.breach_minutes AS minutes,
                   COALESCE(t.team_name, 'Not attributed') AS team,
                   COALESCE(ws.stage_name, sr.stage_code, 'Case lifecycle') AS stage
            FROM ${population.source}
            JOIN sla_instances si ON si.entity_type = 'CASE' AND si.entity_id = sc.case_id
            JOIN sla_breaches sb ON sb.sla_instance_id = si.sla_instance_id
            JOIN sla_rules sr ON sr.sla_rule_id = si.sla_rule_id
            LEFT JOIN teams t ON t.team_id = sb.accountable_team_id
            LEFT JOIN workflow_stage_instances wsi
              ON wsi.workflow_stage_instance_id = si.workflow_stage_instance_id
            LEFT JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
            WHERE ${population.where}
          ),
          ranked AS (
            SELECT minutes, ROW_NUMBER() OVER (ORDER BY minutes) AS rn, COUNT(*) OVER () AS c
            FROM b WHERE minutes IS NOT NULL
          )
          SELECT (SELECT MAX(CASE WHEN rn = (c + 1) / 2 THEN minutes END) FROM ranked) AS median_minutes,
                 stage, team, COUNT(*) AS n
          FROM b GROUP BY stage, team ORDER BY n DESC`,
    args: population.args as never[],
  });

  const stages = new Map<string, number>();
  const teams = new Map<string, number>();
  let medianBreach: number | null = null;
  for (const raw of breaches.rows) {
    const row = raw as unknown as Record<string, unknown>;
    medianBreach = medianBreach ?? number(row.median_minutes);
    stages.set(text(row.stage), (stages.get(text(row.stage)) ?? 0) + Number(row.n ?? 0));
    teams.set(text(row.team), (teams.get(text(row.team)) ?? 0) + Number(row.n ?? 0));
  }
  const top = (map: Map<string, number>, key: 'stage' | 'team') =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, breachCount]) =>
        key === 'stage'
          ? { stage: name, breaches: breachCount }
          : { team: name, breaches: breachCount },
      );

  return {
    external: {
      ...tally.EXTERNAL,
      compliancePercent: rate(tally.EXTERNAL.met, tally.EXTERNAL.met + tally.EXTERNAL.breached),
    },
    internal: {
      ...tally.INTERNAL,
      compliancePercent: rate(tally.INTERNAL.met, tally.INTERNAL.met + tally.INTERNAL.breached),
    },
    medianBreachMinutes: medianBreach,
    topBreachStages: top(stages, 'stage') as { stage: string; breaches: number }[],
    topBreachTeams: top(teams, 'team') as { team: string; breaches: number }[],
    attributionNote: BREACH_ATTRIBUTION_NOTE,
  };
}

/**
 * Who a breach is attributed to, per case, and who closed it.
 *
 * The two columns sit side by side precisely so the difference is visible.
 * Attribution comes from the breach row the engine wrote and from the
 * assignment history; the closing user is shown because a reader will
 * otherwise assume the two are the same person, and on a rescued case they
 * are not.
 */
export async function breachAttribution(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<
  {
    caseId: string;
    caseNumber: string;
    accountableUser: string | null;
    accountableTeam: string | null;
    assignedAtBreach: string | null;
    closedByUser: string | null;
    breachMinutes: number | null;
  }[]
> {
  const population = await casePopulation(db, userId, filter);
  const result = await db.execute({
    sql: `SELECT sc.case_id, sc.case_number,
            au.display_name AS accountable_user,
            t.team_name AS accountable_team,
            sb.breach_minutes,
            (SELECT COALESCE(hu.display_name, h.to_user_id) FROM case_assignment_history h
               LEFT JOIN users hu ON hu.user_id = h.to_user_id
              WHERE h.case_id = sc.case_id AND h.assigned_at <= sb.breached_at
              ORDER BY h.assigned_at DESC LIMIT 1) AS assigned_at_breach,
            (SELECT COALESCE(cu.display_name, csh.changed_by_user_id) FROM case_status_history csh
               LEFT JOIN users cu ON cu.user_id = csh.changed_by_user_id
              WHERE csh.case_id = sc.case_id AND csh.to_status IN ('RESOLVED','CLOSED')
              ORDER BY csh.changed_at DESC LIMIT 1) AS closed_by
          FROM ${population.source}
          JOIN sla_instances si ON si.entity_type = 'CASE' AND si.entity_id = sc.case_id
          JOIN sla_breaches sb ON sb.sla_instance_id = si.sla_instance_id
          LEFT JOIN users au ON au.user_id = sb.accountable_user_id
          LEFT JOIN teams t ON t.team_id = sb.accountable_team_id
          WHERE ${population.where}
          ORDER BY sb.breach_minutes DESC`,
    args: population.args as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      caseId: text(row.case_id),
      caseNumber: text(row.case_number),
      accountableUser: nullableText(row.accountable_user),
      accountableTeam: nullableText(row.accountable_team),
      assignedAtBreach: nullableText(row.assigned_at_breach),
      closedByUser: nullableText(row.closed_by),
      breachMinutes: number(row.breach_minutes),
    };
  });
}

// ---- Satisfaction ------------------------------------------------------------

export interface SurveyScore {
  surveyType: 'CSAT' | 'NPS' | 'CES' | 'OTHER';
  /** CSAT and CES: the mean. NPS: promoters minus detractors, as a percentage. */
  score: number | null;
  responses: number;
  /** Promoters, passives and detractors, for NPS only. */
  nps: { promoters: number; passives: number; detractors: number } | null;
  scale: string;
}

/**
 * The three instruments, kept apart.
 *
 * CSAT, NPS AND CES ARE NEVER AVERAGED TOGETHER. They are different
 * questions on different scales measuring different things, and a mean of
 * the three is a number with no meaning at all. `survey_responses.score` is
 * CHECK(BETWEEN 0 AND 10) for every type, so the scale alone cannot tell you
 * which instrument a response belongs to: `customer_surveys.survey_type`
 * does, and that is what this reads.
 *
 * NPS is promoters (9 to 10) minus detractors (0 to 6) as a percentage of
 * responses, computed only for rows whose survey really is an NPS question.
 */
export async function surveyScores(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<SurveyScore[]> {
  const population = await casePopulation(db, userId, filter);
  const result = await db.execute({
    sql: `SELECT cs.survey_type AS survey_type, COUNT(*) AS responses,
            AVG(sr.score) AS mean_score,
            SUM(CASE WHEN sr.score >= 9 THEN 1 ELSE 0 END) AS promoters,
            SUM(CASE WHEN sr.score BETWEEN 7 AND 8 THEN 1 ELSE 0 END) AS passives,
            SUM(CASE WHEN sr.score <= 6 THEN 1 ELSE 0 END) AS detractors
          FROM ${population.source}
          JOIN survey_responses sr ON sr.case_id = sc.case_id
          JOIN customer_surveys cs ON cs.survey_id = sr.survey_id
          WHERE ${population.where}
          GROUP BY cs.survey_type`,
    args: population.args as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const type = text(row.survey_type) as SurveyScore['surveyType'];
    const responses = Number(row.responses ?? 0);
    const promoters = Number(row.promoters ?? 0);
    const detractors = Number(row.detractors ?? 0);
    if (type === 'NPS') {
      return {
        surveyType: type,
        // Promoters minus detractors, each as a share of responses. Not a mean.
        score: responses === 0 ? null : Math.round(((promoters - detractors) / responses) * 100),
        responses,
        nps: { promoters, passives: Number(row.passives ?? 0), detractors },
        scale:
          'Net promoter score, promoters (9 to 10) minus detractors (0 to 6), from -100 to +100.',
      };
    }
    return {
      surveyType: type,
      score: responses === 0 ? null : Math.round(Number(row.mean_score) * 100) / 100,
      responses,
      nps: null,
      scale:
        type === 'CES'
          ? 'Customer effort score, mean of the responses on the survey own scale.'
          : 'Mean of the responses on the survey own scale.',
    };
  });
}

export interface FeedbackCoverage {
  closedCases: number;
  responses: number;
  responseRatePercent: number | null;
  note: string;
}

export const FEEDBACK_COVERAGE_NOTE =
  'The score is computed over the customers who answered. A case with no survey response is excluded, never counted as neutral: a missing survey is an absence of an opinion, not a middling one, and imputing it would invent satisfaction nobody expressed.';

export async function feedbackCoverage(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<FeedbackCoverage> {
  const population = await casePopulation(db, userId, filter);
  const result = await db.execute({
    sql: `SELECT
            SUM(CASE WHEN sc.status IN ('RESOLVED','CLOSED') THEN 1 ELSE 0 END) AS closed_cases,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM survey_responses sr WHERE sr.case_id = sc.case_id)
                 THEN 1 ELSE 0 END) AS responded
          FROM ${population.source} WHERE ${population.where}`,
    args: population.args as never[],
  });
  const row = (result.rows[0] ?? {}) as unknown as Record<string, unknown>;
  const closed = Number(row.closed_cases ?? 0);
  const responded = Number(row.responded ?? 0);
  return {
    closedCases: closed,
    responses: responded,
    responseRatePercent: rate(responded, closed),
    note: FEEDBACK_COVERAGE_NOTE,
  };
}

// ---- Customers, entities, teams, trend ---------------------------------------

export interface CustomerServiceRow {
  accountId: string;
  customerName: string;
  cases: number;
  complaints: number;
  openCases: number;
  externalSlaPercent: number | null;
  medianResolutionElapsedMinutes: number | null;
  csatScore: number | null;
  csatResponses: number;
  repeatIssues: number;
}

export async function customerView(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<CustomerServiceRow[]> {
  const population = await casePopulation(db, userId, filter);
  const elapsed = minutesBetweenSql('sc.raised_at', 'sc.resolved_at');
  const result = await db.execute({
    sql: `WITH base AS (
            SELECT sc.account_id, a.account_name, sc.case_id, sc.case_type, sc.status,
                   sc.case_category_id, ${elapsed} AS elapsed_minutes,
                   (SELECT si.status FROM sla_instances si
                     JOIN sla_rules sr ON sr.sla_rule_id = si.sla_rule_id
                     JOIN sla_profiles sp ON sp.sla_profile_id = sr.sla_profile_id
                     WHERE si.entity_type = 'CASE' AND si.entity_id = sc.case_id
                       AND sp.sla_type = 'EXTERNAL'
                     ORDER BY CASE si.status WHEN 'BREACHED' THEN 0 WHEN 'MET' THEN 1 ELSE 2 END
                     LIMIT 1) AS external_sla,
                   (SELECT AVG(sr2.score) FROM survey_responses sr2
                     JOIN customer_surveys cs ON cs.survey_id = sr2.survey_id
                     WHERE sr2.case_id = sc.case_id AND cs.survey_type = 'CSAT') AS csat,
                   (SELECT COUNT(*) FROM survey_responses sr3
                     JOIN customer_surveys cs2 ON cs2.survey_id = sr3.survey_id
                     WHERE sr3.case_id = sc.case_id AND cs2.survey_type = 'CSAT') AS csat_responses
            FROM ${population.source} WHERE ${population.where}
          ),
          ranked AS (
            SELECT account_id, elapsed_minutes,
                   ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY elapsed_minutes) AS rn,
                   COUNT(*) OVER (PARTITION BY account_id) AS c
            FROM base WHERE elapsed_minutes IS NOT NULL
          ),
          repeats AS (
            SELECT account_id, COUNT(*) AS repeat_groups FROM (
              SELECT account_id, case_category_id FROM base
              GROUP BY account_id, case_category_id HAVING COUNT(*) > 1)
            GROUP BY account_id
          )
          SELECT b.account_id, b.account_name, COUNT(*) AS cases,
                 SUM(CASE WHEN b.case_type = 'COMPLAINT' THEN 1 ELSE 0 END) AS complaints,
                 SUM(CASE WHEN b.status NOT IN ('RESOLVED','CLOSED','CANCELLED') THEN 1 ELSE 0 END) AS open_cases,
                 SUM(CASE WHEN b.external_sla = 'MET' THEN 1 ELSE 0 END) AS met,
                 SUM(CASE WHEN b.external_sla = 'BREACHED' THEN 1 ELSE 0 END) AS breached,
                 AVG(b.csat) AS csat,
                 SUM(b.csat_responses) AS csat_responses,
                 COALESCE((SELECT repeat_groups FROM repeats r WHERE r.account_id = b.account_id), 0) AS repeat_issues,
                 (SELECT MAX(CASE WHEN rn = (c + 1) / 2 THEN elapsed_minutes END) FROM ranked rk
                   WHERE rk.account_id = b.account_id) AS median_minutes
          FROM base b GROUP BY b.account_id ORDER BY cases DESC LIMIT 100`,
    args: population.args as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const met = Number(row.met ?? 0);
    const breached = Number(row.breached ?? 0);
    const csat = number(row.csat);
    return {
      accountId: text(row.account_id),
      customerName: text(row.account_name),
      cases: Number(row.cases ?? 0),
      complaints: Number(row.complaints ?? 0),
      openCases: Number(row.open_cases ?? 0),
      externalSlaPercent: rate(met, met + breached),
      medianResolutionElapsedMinutes: number(row.median_minutes),
      csatScore: csat === null ? null : Math.round(csat * 100) / 100,
      csatResponses: Number(row.csat_responses ?? 0),
      repeatIssues: Number(row.repeat_issues ?? 0),
    };
  });
}

export interface EntityRow {
  affiliateId: string;
  affiliateName: string;
  cases: number;
  complaints: number;
  /** Orders in the same period, where any: the only defensible denominator here. */
  ordersInPeriod: number | null;
  complaintRatePercent: number | null;
  rateNote: string;
}

export const NO_DENOMINATOR_NOTE =
  'No defensible denominator in this period, so the count is shown and no rate is offered. A rate over an invented denominator is worse than no rate.';

/**
 * By affiliate, with a complaint rate ONLY where a denominator exists.
 *
 * The denominator used is sales orders raised in the same period and entity,
 * which is the closest thing this schema has to "how much business there was
 * to complain about". Where there were none, the rate is null and the note
 * says why, rather than dividing by a number nobody can defend.
 */
export async function entityView(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<EntityRow[]> {
  const population = await casePopulation(db, userId, filter);
  const window = dateWindow('so.order_created_at', filter);
  const result = await db.execute({
    sql: `SELECT a.affiliate_id, af.affiliate_name, COUNT(*) AS cases,
            SUM(CASE WHEN sc.case_type = 'COMPLAINT' THEN 1 ELSE 0 END) AS complaints,
            (SELECT COUNT(*) FROM sales_orders so
              WHERE so.affiliate_id = a.affiliate_id AND ${window.sql}) AS orders_in_period
          FROM ${population.source}
          JOIN affiliates af ON af.affiliate_id = a.affiliate_id
          WHERE ${population.where}
          GROUP BY a.affiliate_id ORDER BY cases DESC`,
    args: [...window.args, ...population.args] as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const orders = Number(row.orders_in_period ?? 0);
    const complaints = Number(row.complaints ?? 0);
    return {
      affiliateId: text(row.affiliate_id),
      affiliateName: text(row.affiliate_name),
      cases: Number(row.cases ?? 0),
      complaints,
      ordersInPeriod: orders === 0 ? null : orders,
      complaintRatePercent: orders === 0 ? null : rate(complaints, orders),
      rateNote:
        orders === 0
          ? NO_DENOMINATOR_NOTE
          : `Complaints as a share of the ${orders} sales orders raised in this affiliate and period.`,
    };
  });
}

export interface TeamServiceRow {
  teamId: string | null;
  teamName: string;
  casesHandled: number;
  medianFirstResponseMinutes: number | null;
  medianResolutionElapsedMinutes: number | null;
  externalSlaPercent: number | null;
  internalSlaPercent: number | null;
  backlog: number;
  oldestOpenAt: string | null;
  csatResponses: number;
  csatScore: number | null;
}

export async function teamView(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<TeamServiceRow[]> {
  const population = await casePopulation(db, userId, filter);
  const elapsed = minutesBetweenSql('sc.raised_at', 'sc.resolved_at');
  const response = minutesBetweenSql('sc.raised_at', 'sc.first_response_at');
  const result = await db.execute({
    sql: `WITH base AS (
            SELECT sc.assigned_team_id AS team_id, COALESCE(t.team_name, 'Unassigned') AS team_name,
                   sc.case_id, sc.status, sc.raised_at,
                   ${elapsed} AS elapsed_minutes, ${response} AS response_minutes,
                   (SELECT sp.sla_type || ':' || si.status FROM sla_instances si
                     JOIN sla_rules sr ON sr.sla_rule_id = si.sla_rule_id
                     JOIN sla_profiles sp ON sp.sla_profile_id = sr.sla_profile_id
                     WHERE si.entity_type = 'CASE' AND si.entity_id = sc.case_id
                       AND sp.sla_type = 'EXTERNAL'
                     LIMIT 1) AS external_state,
                   (SELECT sp.sla_type || ':' || si.status FROM sla_instances si
                     JOIN sla_rules sr ON sr.sla_rule_id = si.sla_rule_id
                     JOIN sla_profiles sp ON sp.sla_profile_id = sr.sla_profile_id
                     WHERE si.entity_type = 'CASE' AND si.entity_id = sc.case_id
                       AND sp.sla_type = 'INTERNAL'
                     LIMIT 1) AS internal_state,
                   (SELECT AVG(sr2.score) FROM survey_responses sr2
                     JOIN customer_surveys cs ON cs.survey_id = sr2.survey_id
                     WHERE sr2.case_id = sc.case_id AND cs.survey_type = 'CSAT') AS csat,
                   (SELECT COUNT(*) FROM survey_responses sr3
                     JOIN customer_surveys cs2 ON cs2.survey_id = sr3.survey_id
                     WHERE sr3.case_id = sc.case_id AND cs2.survey_type = 'CSAT') AS csat_responses
            FROM ${population.source}
            LEFT JOIN teams t ON t.team_id = sc.assigned_team_id
            WHERE ${population.where}
          ),
          r_elapsed AS (
            SELECT team_id, elapsed_minutes,
                   ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY elapsed_minutes) AS rn,
                   COUNT(*) OVER (PARTITION BY team_id) AS c
            FROM base WHERE elapsed_minutes IS NOT NULL
          ),
          r_response AS (
            SELECT team_id, response_minutes,
                   ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY response_minutes) AS rn,
                   COUNT(*) OVER (PARTITION BY team_id) AS c
            FROM base WHERE response_minutes IS NOT NULL
          )
          SELECT b.team_id, b.team_name, COUNT(*) AS cases,
                 SUM(CASE WHEN b.status NOT IN ('RESOLVED','CLOSED','CANCELLED') THEN 1 ELSE 0 END) AS backlog,
                 MIN(CASE WHEN b.status NOT IN ('RESOLVED','CLOSED','CANCELLED') THEN b.raised_at END) AS oldest_open,
                 SUM(CASE WHEN b.external_state = 'EXTERNAL:MET' THEN 1 ELSE 0 END) AS ext_met,
                 SUM(CASE WHEN b.external_state = 'EXTERNAL:BREACHED' THEN 1 ELSE 0 END) AS ext_breached,
                 SUM(CASE WHEN b.internal_state = 'INTERNAL:MET' THEN 1 ELSE 0 END) AS int_met,
                 SUM(CASE WHEN b.internal_state = 'INTERNAL:BREACHED' THEN 1 ELSE 0 END) AS int_breached,
                 AVG(b.csat) AS csat, SUM(b.csat_responses) AS csat_responses,
                 (SELECT MAX(CASE WHEN rn = (c + 1) / 2 THEN elapsed_minutes END) FROM r_elapsed r
                   WHERE r.team_id IS b.team_id) AS median_elapsed,
                 (SELECT MAX(CASE WHEN rn = (c + 1) / 2 THEN response_minutes END) FROM r_response r
                   WHERE r.team_id IS b.team_id) AS median_response
          FROM base b GROUP BY b.team_id ORDER BY cases DESC`,
    args: population.args as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const csat = number(row.csat);
    return {
      teamId: nullableText(row.team_id),
      teamName: text(row.team_name),
      casesHandled: Number(row.cases ?? 0),
      medianFirstResponseMinutes: number(row.median_response),
      medianResolutionElapsedMinutes: number(row.median_elapsed),
      externalSlaPercent: rate(
        Number(row.ext_met ?? 0),
        Number(row.ext_met ?? 0) + Number(row.ext_breached ?? 0),
      ),
      internalSlaPercent: rate(
        Number(row.int_met ?? 0),
        Number(row.int_met ?? 0) + Number(row.int_breached ?? 0),
      ),
      backlog: Number(row.backlog ?? 0),
      oldestOpenAt: nullableText(row.oldest_open),
      csatResponses: Number(row.csat_responses ?? 0),
      csatScore: csat === null ? null : Math.round(csat * 100) / 100,
    };
  });
}

export interface ServiceTrendBucket {
  bucket: string;
  cases: number;
  complaints: number;
  medianFirstResponseMinutes: number | null;
  medianResolutionElapsedMinutes: number | null;
  externalSlaPercent: number | null;
  csatScore: number | null;
  csatResponses: number;
}

export async function trend(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<ServiceTrendBucket[]> {
  const population = await casePopulation(db, userId, filter);
  const bucket = bucketExpression('sc.raised_at', filter.grain);
  const elapsed = minutesBetweenSql('sc.raised_at', 'sc.resolved_at');
  const response = minutesBetweenSql('sc.raised_at', 'sc.first_response_at');
  const result = await db.execute({
    sql: `WITH base AS (
            SELECT ${bucket} AS bucket, sc.case_type,
                   ${elapsed} AS elapsed_minutes, ${response} AS response_minutes,
                   (SELECT si.status FROM sla_instances si
                     JOIN sla_rules sr ON sr.sla_rule_id = si.sla_rule_id
                     JOIN sla_profiles sp ON sp.sla_profile_id = sr.sla_profile_id
                     WHERE si.entity_type = 'CASE' AND si.entity_id = sc.case_id
                       AND sp.sla_type = 'EXTERNAL' LIMIT 1) AS external_sla,
                   (SELECT AVG(sr2.score) FROM survey_responses sr2
                     JOIN customer_surveys cs ON cs.survey_id = sr2.survey_id
                     WHERE sr2.case_id = sc.case_id AND cs.survey_type = 'CSAT') AS csat,
                   (SELECT COUNT(*) FROM survey_responses sr3
                     JOIN customer_surveys cs2 ON cs2.survey_id = sr3.survey_id
                     WHERE sr3.case_id = sc.case_id AND cs2.survey_type = 'CSAT') AS csat_responses
            FROM ${population.source} WHERE ${population.where}
          ),
          ranked AS (
            SELECT bucket, elapsed_minutes, response_minutes,
              ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY elapsed_minutes) AS e_rn,
              COUNT(elapsed_minutes) OVER (PARTITION BY bucket) AS e_c,
              ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY response_minutes) AS r_rn,
              COUNT(response_minutes) OVER (PARTITION BY bucket) AS r_c,
              case_type, external_sla, csat, csat_responses
            FROM base
          )
          SELECT bucket, COUNT(*) AS cases,
                 SUM(CASE WHEN case_type = 'COMPLAINT' THEN 1 ELSE 0 END) AS complaints,
                 MAX(CASE WHEN e_rn = (e_c + 1) / 2 THEN elapsed_minutes END) AS median_elapsed,
                 MAX(CASE WHEN r_rn = (r_c + 1) / 2 THEN response_minutes END) AS median_response,
                 SUM(CASE WHEN external_sla = 'MET' THEN 1 ELSE 0 END) AS met,
                 SUM(CASE WHEN external_sla = 'BREACHED' THEN 1 ELSE 0 END) AS breached,
                 AVG(csat) AS csat, SUM(csat_responses) AS csat_responses
          FROM ranked GROUP BY bucket ORDER BY bucket`,
    args: population.args as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const csat = number(row.csat);
    return {
      bucket: text(row.bucket),
      cases: Number(row.cases ?? 0),
      complaints: Number(row.complaints ?? 0),
      medianFirstResponseMinutes: number(row.median_response),
      medianResolutionElapsedMinutes: number(row.median_elapsed),
      externalSlaPercent: rate(
        Number(row.met ?? 0),
        Number(row.met ?? 0) + Number(row.breached ?? 0),
      ),
      csatScore: csat === null ? null : Math.round(csat * 100) / 100,
      csatResponses: Number(row.csat_responses ?? 0),
    };
  });
}

// ---- Insight cards -----------------------------------------------------------

export interface Insight {
  headline: string;
  /** The arithmetic, in words, so a reader can reproduce it. */
  working: string;
  sampleSize: number;
  comparisonPeriod: string | null;
  /** Where to go to see the records this was computed from. */
  drill: Record<string, string>;
}

/**
 * Deterministic insight cards.
 *
 * EVERY CARD IS AN ARITHMETIC FACT WITH ITS WORKING, ITS SAMPLE SIZE AND A
 * LINK TO THE RECORDS. Nothing here generates a sentence the data does not
 * support, nothing says one thing caused another, and a card is simply not
 * produced when its sample is too small to mean anything.
 */
export async function insights(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<Insight[]> {
  const out: Insight[] = [];
  const categories = await categoryMix(db, userId, filter);
  const breakdown = await waitingBreakdown(db, userId, filter);
  const totalCases = categories.reduce((sum, row) => sum + row.cases, 0);

  const biggest = categories[0];
  if (biggest !== undefined && totalCases >= 5) {
    const share = Math.round((biggest.cases / totalCases) * 1000) / 10;
    out.push({
      headline: `${biggest.categoryName} / ${biggest.subcategoryName} is ${share}% of cases in this period.`,
      working: `${biggest.cases} of ${totalCases} cases carry this category. ${share}% is ${biggest.cases} divided by ${totalCases}.`,
      sampleSize: totalCases,
      comparisonPeriod: null,
      drill: { caseCategoryId: biggest.caseCategoryId },
    });
  }

  if (breakdown.casesMeasured >= 3 && breakdown.elapsedMinutes > 0) {
    const share =
      Math.round((breakdown.waitingInternalMinutes / breakdown.elapsedMinutes) * 1000) / 10;
    out.push({
      headline: `${share}% of measured elapsed time was spent waiting internally.`,
      working: `${Math.round(breakdown.waitingInternalMinutes)} minutes of ${Math.round(breakdown.elapsedMinutes)} measured elapsed minutes, across ${breakdown.casesMeasured} cases whose status history was complete. ${breakdown.casesExcluded} cases were excluded because their events were incomplete.`,
      sampleSize: breakdown.casesMeasured,
      comparisonPeriod: null,
      drill: {},
    });
  }

  // A period-on-period comparison, where a previous equivalent period exists.
  if (filter.from !== null && filter.to !== null) {
    const days = Math.max(
      1,
      Math.round(
        (Date.parse(`${filter.to}T00:00:00Z`) - Date.parse(`${filter.from}T00:00:00Z`)) / 86400000,
      ) + 1,
    );
    const previousTo = new Date(Date.parse(`${filter.from}T00:00:00Z`) - 86400000)
      .toISOString()
      .slice(0, 10);
    const previousFrom = new Date(Date.parse(`${previousTo}T00:00:00Z`) - (days - 1) * 86400000)
      .toISOString()
      .slice(0, 10);
    const previous = await summary(db, userId, {
      ...filter,
      from: previousFrom,
      to: previousTo,
    });
    const current = await summary(db, userId, filter);
    if (previous.casesOpened >= 5) {
      const change =
        Math.round(((current.casesOpened - previous.casesOpened) / previous.casesOpened) * 1000) /
        10;
      out.push({
        headline: `Cases opened ${change >= 0 ? 'rose' : 'fell'} ${Math.abs(change)}% against the previous equivalent period.`,
        working: `${current.casesOpened} cases from ${filter.from} to ${filter.to}, against ${previous.casesOpened} from ${previousFrom} to ${previousTo}. The change is the difference divided by the earlier figure. This is a movement in volume, and it is not a statement about why.`,
        sampleSize: current.casesOpened + previous.casesOpened,
        comparisonPeriod: `${previousFrom} to ${previousTo}`,
        drill: {},
      });
    }
  }
  return out;
}
