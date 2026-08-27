/**
 * CRM analytics.
 *
 * THE DENOMINATOR IS THE WHOLE ARGUMENT.
 * A rate without the population it was taken over is not a number anybody
 * can act on. Every rate here carries its denominator, and the win rate in
 * particular excludes open opportunities: including them is the commonest
 * error in a CRM dashboard, and it makes the win rate drift with pipeline
 * size rather than with anybody's performance.
 *
 * PROBABILITY IS A FRACTION BETWEEN 0 AND 1.
 * The column's own CHECK says so. Weighted pipeline multiplies by that
 * fraction and the interface renders it as a percentage. Multiplying by 80
 * because the label says "80%" would inflate every weighted figure by a
 * factor of a hundred.
 *
 * CURRENCIES ARE NEVER SUMMED.
 * There is no exchange rate in this schema and none is invented, so every
 * money figure is grouped by currency and no row adds two of them together.
 *
 * NO THRESHOLD IS INVENTED.
 * "Stale" is not a concept this application owns. Where a pipeline stage has
 * a configured `target_days`, an open opportunity past it is at risk; where
 * no target is configured, the age is shown as a fact and no judgement is
 * attached to it.
 */
import type { Client } from '@libsql/client/web';
import { scopedLeads } from './leadAdmin.ts';
import { scopedOpportunities } from './opportunityAdmin.ts';
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

/**
 * The lead population: the Build Prompt 07 scope, then the filter. The date
 * basis is `captured_at`, which is when the enquiry arrived.
 */
export async function leadPopulation(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<Population> {
  const scope = await scopedLeads(db, userId);
  const combined = andAll([
    { sql: scope.sql, args: scope.args as (string | number)[] },
    dateWindow('l.captured_at', filter),
    equals('l.owner_user_id', filter.ownerId),
    equals('l.lead_source_id', filter.leadSourceId),
    equals('l.business_unit_id', filter.businessUnitId),
    equals('l.status', filter.status),
    equals('l.currency_code', filter.currency),
    equals('a.affiliate_id', filter.affiliateId),
    equals('a.country_id', filter.countryId),
  ]);
  return {
    source: `leads l LEFT JOIN accounts a ON a.account_id = l.account_id`,
    where: combined.sql,
    args: combined.args,
  };
}

/**
 * The opportunity population. The date basis is `created_at`, and a metric
 * measured on close says so and filters on `actual_close_date` instead.
 */
export async function opportunityPopulation(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  dateColumn = 'o.created_at',
): Promise<Population> {
  const scope = await scopedOpportunities(db, userId);
  const combined = andAll([
    { sql: scope.sql, args: scope.args as (string | number)[] },
    dateWindow(dateColumn, filter),
    equals('o.owner_user_id', filter.ownerId),
    equals('o.pipeline_id', filter.pipelineId),
    equals('o.current_stage_id', filter.pipelineStageId),
    equals('o.business_unit_id', filter.businessUnitId),
    equals('o.currency_code', filter.currency),
    equals('o.status', filter.status),
    equals('a.affiliate_id', filter.affiliateId),
    equals('a.country_id', filter.countryId),
    filter.productId === null && filter.productCategoryId === null && filter.productGroupId === null
      ? { sql: '1 = 1', args: [] }
      : {
          sql: `EXISTS (SELECT 1 FROM opportunity_products op
                  JOIN products p ON p.product_id = op.product_id
                  JOIN product_categories pc ON pc.product_category_id = p.product_category_id
                  WHERE op.opportunity_id = o.opportunity_id
                    AND (? IS NULL OR p.product_id = ?)
                    AND (? IS NULL OR p.product_category_id = ?)
                    AND (? IS NULL OR pc.product_group_id = ?))`,
          args: [
            filter.productId ?? '',
            filter.productId ?? '',
            filter.productCategoryId ?? '',
            filter.productCategoryId ?? '',
            filter.productGroupId ?? '',
            filter.productGroupId ?? '',
          ],
        },
    filter.teamId === null
      ? { sql: '1 = 1', args: [] }
      : {
          // Effective-dated membership: the owner has to have been in the
          // team at the time the opportunity was created, not today.
          sql: `EXISTS (SELECT 1 FROM team_members tm
                  WHERE tm.user_id = o.owner_user_id AND tm.team_id = ?
                    AND tm.effective_from <= o.created_at
                    AND (tm.effective_to IS NULL OR tm.effective_to >= o.created_at))`,
          args: [filter.teamId],
        },
  ]);
  return {
    source: `opportunities o JOIN accounts a ON a.account_id = o.account_id`,
    where: combined.sql,
    args: combined.args,
  };
}

// ---- The funnel --------------------------------------------------------------

export interface FunnelStep {
  step: string;
  leads: number;
  /** Conversion from the previous step, with the denominator named. */
  conversionPercent: number | null;
  denominator: string;
  drill: Record<string, string>;
}

export interface Funnel {
  steps: FunnelStep[];
  qualificationRatePercent: number | null;
  qualificationDenominator: number;
  conversionRatePercent: number | null;
  conversionDenominator: number;
}

/**
 * The funnel, as stepped counts.
 *
 * DELIBERATELY NOT A TAPERING SHAPE. A classic funnel encodes a count as an
 * area, and an area whose width and height both shrink falls away far faster
 * than the number does, so a step retaining 70 per cent looks like it
 * retained 40. The chart module draws bars for this reason.
 *
 * The two rates carry their own denominators, stated here and shown in the
 * interface:
 *   Qualification rate = qualified / eligible, where eligible is every lead
 *   that reached a decision or is still in play, which is every lead in the
 *   selection. A disqualified lead was still a chance to qualify one.
 *   Conversion rate = converted / qualified. A lead that never qualified was
 *   never a candidate for conversion, so it is not in this denominator.
 */
export async function funnel(db: Client, userId: string, filter: AnalyticsFilter): Promise<Funnel> {
  const population = await leadPopulation(db, userId, filter);
  const result = await db.execute({
    sql: `SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN l.status = 'NEW' THEN 1 ELSE 0 END) AS new_leads,
            SUM(CASE WHEN l.first_contact_at IS NOT NULL THEN 1 ELSE 0 END) AS contacted,
            SUM(CASE WHEN l.status IN ('QUALIFIED','CONVERTED') THEN 1 ELSE 0 END) AS qualified,
            SUM(CASE WHEN l.status = 'CONVERTED' THEN 1 ELSE 0 END) AS converted,
            SUM(CASE WHEN l.status = 'DISQUALIFIED' THEN 1 ELSE 0 END) AS disqualified
          FROM ${population.source} WHERE ${population.where}`,
    args: population.args as never[],
  });
  const row = (result.rows[0] ?? {}) as unknown as Record<string, unknown>;
  const total = Number(row.total ?? 0);
  const contacted = Number(row.contacted ?? 0);
  const qualified = Number(row.qualified ?? 0);
  const converted = Number(row.converted ?? 0);
  const disqualified = Number(row.disqualified ?? 0);

  return {
    steps: [
      {
        step: 'Captured',
        leads: total,
        conversionPercent: null,
        denominator: 'Every lead captured in this period and scope.',
        drill: {},
      },
      {
        step: 'Contacted',
        leads: contacted,
        conversionPercent: rate(contacted, total),
        denominator: `${total} leads captured`,
        drill: { status: 'CONTACTED' },
      },
      {
        step: 'Qualified',
        leads: qualified,
        conversionPercent: rate(qualified, contacted),
        denominator: `${contacted} leads contacted`,
        drill: { status: 'QUALIFIED' },
      },
      {
        step: 'Converted',
        leads: converted,
        conversionPercent: rate(converted, qualified),
        denominator: `${qualified} leads qualified`,
        drill: { status: 'CONVERTED' },
      },
      {
        step: 'Disqualified',
        leads: disqualified,
        conversionPercent: rate(disqualified, total),
        denominator: `${total} leads captured`,
        drill: { status: 'DISQUALIFIED' },
      },
    ],
    qualificationRatePercent: rate(qualified, total),
    qualificationDenominator: total,
    conversionRatePercent: rate(converted, qualified),
    conversionDenominator: qualified,
  };
}

// ---- Pipeline value ----------------------------------------------------------

export interface PipelineValueRow {
  currencyCode: string;
  openOpportunities: number;
  openValue: number;
  /** Sum of estimated_value * probability, the probability being a fraction. */
  weightedValue: number;
  /** The weighted share, rendered as a percentage for a person to read. */
  averageProbabilityPercent: number | null;
}

export async function pipelineValue(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<PipelineValueRow[]> {
  const population = await opportunityPopulation(db, userId, filter);
  const result = await db.execute({
    sql: `SELECT o.currency_code AS currency, COUNT(*) AS opportunities,
            SUM(o.estimated_value) AS open_value,
            SUM(o.estimated_value * o.probability) AS weighted_value,
            AVG(o.probability) AS average_probability
          FROM ${population.source}
          WHERE ${population.where} AND o.status = 'OPEN'
          GROUP BY o.currency_code ORDER BY open_value DESC`,
    args: population.args as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const probability = number(row.average_probability);
    return {
      currencyCode: text(row.currency),
      openOpportunities: Number(row.opportunities ?? 0),
      openValue: Number(row.open_value ?? 0),
      weightedValue: Number(row.weighted_value ?? 0),
      // Stored as a fraction, displayed as a percentage. One conversion, here.
      averageProbabilityPercent: probability === null ? null : Math.round(probability * 1000) / 10,
    };
  });
}

export interface WinRate {
  won: number;
  lost: number;
  /** Open opportunities, counted and reported, and NOT in the denominator. */
  open: number;
  denominator: number;
  winRatePercent: number | null;
  definition: string;
}

export const WIN_RATE_DEFINITION =
  'Won divided by won plus lost. Open opportunities are NOT in the denominator: including them makes the win rate move with pipeline size rather than with performance, and it falls every time somebody adds a deal.';

export async function winRate(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<WinRate> {
  const population = await opportunityPopulation(db, userId, filter);
  const result = await db.execute({
    sql: `SELECT
            SUM(CASE WHEN o.status = 'WON' THEN 1 ELSE 0 END) AS won,
            SUM(CASE WHEN o.status = 'LOST' THEN 1 ELSE 0 END) AS lost,
            SUM(CASE WHEN o.status = 'OPEN' THEN 1 ELSE 0 END) AS open_count
          FROM ${population.source} WHERE ${population.where}`,
    args: population.args as never[],
  });
  const row = (result.rows[0] ?? {}) as unknown as Record<string, unknown>;
  const won = Number(row.won ?? 0);
  const lost = Number(row.lost ?? 0);
  return {
    won,
    lost,
    open: Number(row.open_count ?? 0),
    denominator: won + lost,
    winRatePercent: rate(won, won + lost),
    definition: WIN_RATE_DEFINITION,
  };
}

// ---- Stage analysis and velocity ---------------------------------------------

export interface StageRow {
  pipelineStageId: string;
  stageName: string;
  sequenceNo: number;
  targetDays: number | null;
  openOpportunities: number;
  currencyBreakdown: { currencyCode: string; openValue: number; weightedValue: number }[];
  medianStageAgeMinutes: number | null;
  /** Open opportunities past the stage's configured target. Null where none is configured. */
  atRisk: number | null;
}

/**
 * Stage occupancy: where opportunities are sitting now, and how long they
 * have been there. This is the accumulation view.
 *
 * At risk is computed ONLY where the stage has a configured `target_days`.
 * Where the configuration is silent this returns null and the interface
 * shows the age without a judgement, because inventing a threshold would
 * invent a policy nobody agreed.
 */
export async function stageOccupancy(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<StageRow[]> {
  const population = await opportunityPopulation(db, userId, filter);
  const ageSql = `(julianday(?) - julianday(
      COALESCE((SELECT MAX(h.changed_at) FROM opportunity_stage_history h
                 WHERE h.opportunity_id = o.opportunity_id AND h.to_stage_id = o.current_stage_id),
               o.created_at))) * 1440.0`;
  const result = await db.execute({
    sql: `WITH open_ops AS (
            SELECT o.opportunity_id, o.current_stage_id, o.currency_code, o.estimated_value,
                   o.probability, ${ageSql} AS stage_age
            FROM ${population.source}
            WHERE ${population.where} AND o.status = 'OPEN'
          ),
          ranked AS (
            SELECT current_stage_id, stage_age,
                   ROW_NUMBER() OVER (PARTITION BY current_stage_id ORDER BY stage_age) AS rn,
                   COUNT(*) OVER (PARTITION BY current_stage_id) AS c
            FROM open_ops
          )
          SELECT ps.pipeline_stage_id AS stage_id, ps.stage_name, ps.sequence_no, ps.target_days,
                 COUNT(op.opportunity_id) AS open_count,
                 (SELECT MAX(CASE WHEN rn = (c + 1) / 2 THEN stage_age END) FROM ranked r
                   WHERE r.current_stage_id = ps.pipeline_stage_id) AS median_age,
                 SUM(CASE WHEN ps.target_days IS NOT NULL
                          AND op.stage_age > ps.target_days * 1440.0 THEN 1 ELSE 0 END) AS at_risk
          FROM pipeline_stages ps
          LEFT JOIN open_ops op ON op.current_stage_id = ps.pipeline_stage_id
          WHERE ps.active = 1
          GROUP BY ps.pipeline_stage_id
          ORDER BY ps.sequence_no`,
    args: [now, ...population.args] as never[],
  });

  const values = await db.execute({
    sql: `SELECT o.current_stage_id AS stage_id, o.currency_code AS currency,
            SUM(o.estimated_value) AS open_value,
            SUM(o.estimated_value * o.probability) AS weighted_value
          FROM ${population.source}
          WHERE ${population.where} AND o.status = 'OPEN'
          GROUP BY o.current_stage_id, o.currency_code`,
    args: population.args as never[],
  });
  const byStage = new Map<
    string,
    { currencyCode: string; openValue: number; weightedValue: number }[]
  >();
  for (const raw of values.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const key = text(row.stage_id);
    byStage.set(key, [
      ...(byStage.get(key) ?? []),
      {
        currencyCode: text(row.currency),
        openValue: Number(row.open_value ?? 0),
        weightedValue: Number(row.weighted_value ?? 0),
      },
    ]);
  }

  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const stageId = text(row.stage_id);
    const targetDays = number(row.target_days);
    return {
      pipelineStageId: stageId,
      stageName: text(row.stage_name),
      sequenceNo: Number(row.sequence_no),
      targetDays,
      openOpportunities: Number(row.open_count ?? 0),
      currencyBreakdown: byStage.get(stageId) ?? [],
      medianStageAgeMinutes: number(row.median_age),
      // No target configured, no judgement. The age is still shown.
      atRisk: targetDays === null ? null : Number(row.at_risk ?? 0),
    };
  });
}

export interface VelocityRow {
  pipelineStageId: string;
  stageName: string;
  sequenceNo: number;
  transitions: number;
  medianMinutes: number | null;
  averageMinutes: number | null;
  p90Minutes: number | null;
}

/**
 * Stage velocity, from `opportunity_stage_history`.
 *
 * NOT FROM THE CURRENT STAGE AGE. An opportunity that has already moved on
 * contributes nothing to a current-age figure, so a current-age "velocity"
 * describes only the deals that are stuck, which is precisely the wrong
 * population. The history table records every transition with the time spent
 * in the stage it left, and that is what this reads.
 */
export async function stageVelocity(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<VelocityRow[]> {
  const population = await opportunityPopulation(db, userId, filter);
  const result = await db.execute({
    sql: `WITH moves AS (
            SELECT h.from_stage_id AS stage_id,
                   COALESCE(h.duration_in_previous_stage_minutes,
                            ${minutesBetweenSql('prev.changed_at', 'h.changed_at')}) AS v
            FROM ${population.source}
            JOIN opportunity_stage_history h ON h.opportunity_id = o.opportunity_id
            LEFT JOIN opportunity_stage_history prev
              ON prev.opportunity_id = h.opportunity_id AND prev.to_stage_id = h.from_stage_id
            WHERE ${population.where} AND h.from_stage_id IS NOT NULL
          ),
          ranked AS (
            SELECT stage_id, v,
                   ROW_NUMBER() OVER (PARTITION BY stage_id ORDER BY v) AS rn,
                   COUNT(*) OVER (PARTITION BY stage_id) AS c
            FROM moves WHERE v IS NOT NULL
          )
          SELECT ps.pipeline_stage_id AS stage_id, ps.stage_name, ps.sequence_no,
                 (SELECT COUNT(*) FROM moves m WHERE m.stage_id = ps.pipeline_stage_id) AS transitions,
                 (SELECT AVG(v) FROM moves m WHERE m.stage_id = ps.pipeline_stage_id) AS average_minutes,
                 (SELECT MAX(CASE WHEN rn = (c + 1) / 2 THEN v END) FROM ranked r
                   WHERE r.stage_id = ps.pipeline_stage_id) AS median_minutes,
                 (SELECT MAX(CASE WHEN rn = (c * 9 + 9) / 10 THEN v END) FROM ranked r
                   WHERE r.stage_id = ps.pipeline_stage_id) AS p90_minutes
          FROM pipeline_stages ps
          WHERE ps.active = 1
          ORDER BY ps.sequence_no`,
    args: population.args as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      pipelineStageId: text(row.stage_id),
      stageName: text(row.stage_name),
      sequenceNo: Number(row.sequence_no),
      transitions: Number(row.transitions ?? 0),
      medianMinutes: number(row.median_minutes),
      averageMinutes: number(row.average_minutes),
      p90Minutes: number(row.p90_minutes),
    };
  });
}

// ---- First contact, BANT and sources -----------------------------------------

export interface FirstContact {
  leads: number;
  contacted: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
  /** From the SLA engine's own instances where a CRM rule is configured. */
  withinSlaPercent: number | null;
  slaMeasured: number;
  uncontacted: number;
  oldestUncontactedAt: string | null;
}

export async function firstContact(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<FirstContact> {
  const population = await leadPopulation(db, userId, filter);
  const result = await db.execute({
    sql: `WITH base AS (
            SELECT l.lead_id, l.captured_at, l.first_contact_at,
                   ${minutesBetweenSql('l.captured_at', 'l.first_contact_at')} AS v,
                   (SELECT si.status FROM sla_instances si
                     WHERE si.entity_type = 'LEAD' AND si.entity_id = l.lead_id
                     ORDER BY CASE si.status WHEN 'BREACHED' THEN 0 WHEN 'MET' THEN 1 ELSE 2 END
                     LIMIT 1) AS sla_status
            FROM ${population.source} WHERE ${population.where}
          ),
          ranked AS (
            SELECT v, ROW_NUMBER() OVER (ORDER BY v) AS rn, COUNT(*) OVER () AS c
            FROM base WHERE v IS NOT NULL
          )
          SELECT COUNT(*) AS leads,
                 SUM(CASE WHEN first_contact_at IS NOT NULL THEN 1 ELSE 0 END) AS contacted,
                 SUM(CASE WHEN first_contact_at IS NULL THEN 1 ELSE 0 END) AS uncontacted,
                 MIN(CASE WHEN first_contact_at IS NULL THEN captured_at END) AS oldest_uncontacted,
                 SUM(CASE WHEN sla_status = 'MET' THEN 1 ELSE 0 END) AS met,
                 SUM(CASE WHEN sla_status = 'BREACHED' THEN 1 ELSE 0 END) AS breached,
                 (SELECT MAX(CASE WHEN rn = (c + 1) / 2 THEN v END) FROM ranked) AS median_minutes,
                 (SELECT MAX(CASE WHEN rn = (c * 9 + 9) / 10 THEN v END) FROM ranked) AS p90_minutes
          FROM base`,
    args: population.args as never[],
  });
  const row = (result.rows[0] ?? {}) as unknown as Record<string, unknown>;
  const met = Number(row.met ?? 0);
  const breached = Number(row.breached ?? 0);
  return {
    leads: Number(row.leads ?? 0),
    contacted: Number(row.contacted ?? 0),
    medianMinutes: number(row.median_minutes),
    p90Minutes: number(row.p90_minutes),
    withinSlaPercent: rate(met, met + breached),
    slaMeasured: met + breached,
    uncontacted: Number(row.uncontacted ?? 0),
    oldestUncontactedAt: nullableText(row.oldest_uncontacted),
  };
}

export interface BantRow {
  dimension: 'Budget' | 'Authority' | 'Need' | 'Timeline';
  averageWhenConverted: number | null;
  averageWhenNotConverted: number | null;
  assessments: number;
}

export const BANT_WORDING =
  'Each dimension is reported on its own, on the assessor’s 0 to 5 scale. There is no combined lead score: the four are different questions and adding them produces a number that hides which one was weak. Any difference between the converted and unconverted columns is an observation about this sample and is not a cause.';

/**
 * BANT, four dimensions, four averages.
 *
 * NO SINGLE MAGIC SCORE. Summing budget, authority, need and timeline
 * produces a number that cannot be acted on: a 12 could be a strong need
 * with no budget or an eager buyer with no authority, and the two want
 * different responses.
 *
 * The converted and unconverted columns sit side by side so a reader can see
 * that, say, low authority leads convert less often in this sample. The
 * wording above says that is an observation. It is not evidence that low
 * authority caused the outcome.
 */
export async function bant(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<{ rows: BantRow[]; wording: string }> {
  const population = await leadPopulation(db, userId, filter);
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS assessments,
            AVG(CASE WHEN l.status = 'CONVERTED' THEN q.budget_score END) AS budget_converted,
            AVG(CASE WHEN l.status <> 'CONVERTED' THEN q.budget_score END) AS budget_other,
            AVG(CASE WHEN l.status = 'CONVERTED' THEN q.authority_score END) AS authority_converted,
            AVG(CASE WHEN l.status <> 'CONVERTED' THEN q.authority_score END) AS authority_other,
            AVG(CASE WHEN l.status = 'CONVERTED' THEN q.need_score END) AS need_converted,
            AVG(CASE WHEN l.status <> 'CONVERTED' THEN q.need_score END) AS need_other,
            AVG(CASE WHEN l.status = 'CONVERTED' THEN q.timeline_score END) AS timeline_converted,
            AVG(CASE WHEN l.status <> 'CONVERTED' THEN q.timeline_score END) AS timeline_other
          FROM ${population.source}
          JOIN lead_qualifications q ON q.lead_id = l.lead_id
          WHERE ${population.where}`,
    args: population.args as never[],
  });
  const row = (result.rows[0] ?? {}) as unknown as Record<string, unknown>;
  const assessments = Number(row.assessments ?? 0);
  const make = (
    dimension: BantRow['dimension'],
    convertedKey: string,
    otherKey: string,
  ): BantRow => ({
    dimension,
    averageWhenConverted: number(row[convertedKey]),
    averageWhenNotConverted: number(row[otherKey]),
    assessments,
  });
  return {
    wording: BANT_WORDING,
    rows: [
      make('Budget', 'budget_converted', 'budget_other'),
      make('Authority', 'authority_converted', 'authority_other'),
      make('Need', 'need_converted', 'need_other'),
      make('Timeline', 'timeline_converted', 'timeline_other'),
    ],
  };
}

export interface LeadSourceRow {
  leadSourceId: string;
  sourceName: string;
  /** True where the source is the customer service team's own referrals. */
  isCustomerService: boolean;
  leads: number;
  qualified: number;
  converted: number;
  conversionPercent: number | null;
  wonValueByCurrency: { currencyCode: string; wonValue: number }[];
}

/**
 * The lead sources that represent a customer service origin.
 *
 * `lead_sources` carries no category column, and adding one would be a
 * schema change this batch does not permit. So this is a CONFIGURED LIST of
 * source ids rather than a match on the words in a name: "Customer Service
 * Referral" is LS-001 in the seeded data, and an administrator who adds
 * another service-origin source adds its id here. A containment test on the
 * name would silently reclassify a source the day somebody renamed it.
 */
export const CUSTOMER_SERVICE_LEAD_SOURCES: readonly string[] = ['LS-001'];

/**
 * Performance by lead source, with customer-service-originated leads
 * identifiable in their own right.
 *
 * That team generating commercial opportunities is a stated business
 * requirement and the thing they would otherwise get no credit for, so the
 * flag is explicit and the total is reported separately in the interface.
 */
export async function leadSourcePerformance(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<LeadSourceRow[]> {
  const population = await leadPopulation(db, userId, filter);
  const result = await db.execute({
    sql: `SELECT ls.lead_source_id AS id, ls.source_name AS name,
            COUNT(*) AS leads,
            SUM(CASE WHEN l.status IN ('QUALIFIED','CONVERTED') THEN 1 ELSE 0 END) AS qualified,
            SUM(CASE WHEN l.status = 'CONVERTED' THEN 1 ELSE 0 END) AS converted
          FROM ${population.source}
          JOIN lead_sources ls ON ls.lead_source_id = l.lead_source_id
          WHERE ${population.where}
          GROUP BY ls.lead_source_id ORDER BY leads DESC`,
    args: population.args as never[],
  });

  const won = await db.execute({
    sql: `SELECT l.lead_source_id AS id, o.currency_code AS currency,
            SUM(COALESCE(o.won_amount, o.estimated_value)) AS won_value
          FROM ${population.source}
          JOIN opportunities o ON o.lead_id = l.lead_id AND o.status = 'WON'
          WHERE ${population.where}
          GROUP BY l.lead_source_id, o.currency_code`,
    args: population.args as never[],
  });
  const wonBySource = new Map<string, { currencyCode: string; wonValue: number }[]>();
  for (const raw of won.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const key = text(row.id);
    wonBySource.set(key, [
      ...(wonBySource.get(key) ?? []),
      { currencyCode: text(row.currency), wonValue: Number(row.won_value ?? 0) },
    ]);
  }

  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const id = text(row.id);
    const leads = Number(row.leads ?? 0);
    return {
      leadSourceId: id,
      sourceName: text(row.name),
      isCustomerService: CUSTOMER_SERVICE_LEAD_SOURCES.includes(id),
      leads,
      qualified: Number(row.qualified ?? 0),
      converted: Number(row.converted ?? 0),
      conversionPercent: rate(Number(row.converted ?? 0), leads),
      wonValueByCurrency: wonBySource.get(id) ?? [],
    };
  });
}

// ---- Products, owners, teams, losses -----------------------------------------

export interface ProductPipelineRow {
  productGroupName: string;
  productCategoryName: string;
  productCode: string;
  unitOfMeasure: string;
  openOpportunities: number;
  /** Only ever within one unit of measure. Litres and units are not addable. */
  expectedQuantity: number | null;
  pipelineByCurrency: { currencyCode: string; pipelineValue: number; wonValue: number }[];
}

/**
 * The product pipeline.
 *
 * QUANTITIES ARE NEVER SUMMED ACROSS UNITS. Litres of AGO and units of
 * lubricant are different physical things, and `products.unit_of_measure`
 * says which is which. Every row carries one product and therefore one unit,
 * and no total is offered across rows.
 */
export async function productPipeline(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<ProductPipelineRow[]> {
  const population = await opportunityPopulation(db, userId, filter);
  const result = await db.execute({
    sql: `SELECT pg.group_name, pc.category_name, p.product_code, p.unit_of_measure,
            COUNT(DISTINCT CASE WHEN o.status = 'OPEN' THEN o.opportunity_id END) AS open_count,
            SUM(CASE WHEN o.status = 'OPEN' THEN op.expected_quantity END) AS quantity,
            o.currency_code AS currency,
            SUM(CASE WHEN o.status = 'OPEN' THEN COALESCE(op.estimated_line_value, 0) END) AS pipeline_value,
            SUM(CASE WHEN o.status = 'WON' THEN COALESCE(op.estimated_line_value, 0) END) AS won_value
          FROM ${population.source}
          JOIN opportunity_products op ON op.opportunity_id = o.opportunity_id
          JOIN products p ON p.product_id = op.product_id
          JOIN product_categories pc ON pc.product_category_id = p.product_category_id
          JOIN product_groups pg ON pg.product_group_id = pc.product_group_id
          WHERE ${population.where}
          GROUP BY p.product_id, o.currency_code
          ORDER BY open_count DESC`,
    args: population.args as never[],
  });

  const byProduct = new Map<string, ProductPipelineRow>();
  for (const raw of result.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const code = text(row.product_code);
    const existing = byProduct.get(code) ?? {
      productGroupName: text(row.group_name),
      productCategoryName: text(row.category_name),
      productCode: code,
      unitOfMeasure: text(row.unit_of_measure),
      openOpportunities: 0,
      expectedQuantity: null,
      pipelineByCurrency: [],
    };
    existing.openOpportunities += Number(row.open_count ?? 0);
    const quantity = number(row.quantity);
    if (quantity !== null) {
      existing.expectedQuantity = (existing.expectedQuantity ?? 0) + quantity;
    }
    existing.pipelineByCurrency.push({
      currencyCode: text(row.currency),
      pipelineValue: Number(row.pipeline_value ?? 0),
      wonValue: Number(row.won_value ?? 0),
    });
    byProduct.set(code, existing);
  }
  return [...byProduct.values()];
}

export interface OwnerRow {
  userId: string;
  owner: string;
  leadsOwned: number;
  firstContactWithinSlaPercent: number | null;
  openOpportunities: number;
  pipelineByCurrency: { currencyCode: string; openValue: number }[];
  won: number;
  lost: number;
  winRatePercent: number | null;
  overdueFollowUps: number;
  rankEligible: boolean;
}

/**
 * Owner performance, with the context that makes it readable.
 *
 * NOT RANKED ON REVENUE. Portfolio size, territory and product mix differ
 * between people, and a table sorted by money says only who was given the
 * largest accounts. The rows are ordered by pipeline volume and every figure
 * is shown beside its context; a comparative rank is gated on the same
 * minimum volume as the other performance tables.
 */
export async function ownerPerformance(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<{ rows: OwnerRow[]; minimumVolume: number }> {
  const leadPop = await leadPopulation(db, userId, filter);
  const oppPop = await opportunityPopulation(db, userId, filter);

  const [leadRows, oppRows, followUps] = await Promise.all([
    db.execute({
      sql: `SELECT l.owner_user_id AS user_id, COALESCE(u.display_name, l.owner_user_id) AS owner,
              COUNT(*) AS leads,
              SUM(CASE WHEN si.status = 'MET' THEN 1 ELSE 0 END) AS met,
              SUM(CASE WHEN si.status = 'BREACHED' THEN 1 ELSE 0 END) AS breached
            FROM ${leadPop.source}
            LEFT JOIN users u ON u.user_id = l.owner_user_id
            LEFT JOIN sla_instances si ON si.entity_type = 'LEAD' AND si.entity_id = l.lead_id
            WHERE ${leadPop.where}
            GROUP BY l.owner_user_id`,
      args: leadPop.args as never[],
    }),
    db.execute({
      sql: `SELECT o.owner_user_id AS user_id, COALESCE(u.display_name, o.owner_user_id) AS owner,
              o.currency_code AS currency,
              SUM(CASE WHEN o.status = 'OPEN' THEN 1 ELSE 0 END) AS open_count,
              SUM(CASE WHEN o.status = 'OPEN' THEN o.estimated_value ELSE 0 END) AS open_value,
              SUM(CASE WHEN o.status = 'WON' THEN 1 ELSE 0 END) AS won,
              SUM(CASE WHEN o.status = 'LOST' THEN 1 ELSE 0 END) AS lost
            FROM ${oppPop.source}
            LEFT JOIN users u ON u.user_id = o.owner_user_id
            WHERE ${oppPop.where}
            GROUP BY o.owner_user_id, o.currency_code`,
      args: oppPop.args as never[],
    }),
    db.execute({
      // An activity is outstanding when it has not been completed. The
      // table has no status column: completion is a timestamp, and its
      // absence is what "still to do" means.
      sql: `SELECT act.owner_user_id AS user_id, COUNT(*) AS overdue
            FROM activities act
            WHERE act.completed_at IS NULL
              AND COALESCE(act.next_action_due, act.scheduled_at) IS NOT NULL
              AND COALESCE(act.next_action_due, act.scheduled_at) < ?
            GROUP BY act.owner_user_id`,
      args: [now],
    }),
  ]);

  const overdueByUser = new Map(
    followUps.rows.map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      return [text(row.user_id), Number(row.overdue ?? 0)];
    }),
  );
  const rows = new Map<string, OwnerRow>();
  for (const raw of leadRows.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const id = text(row.user_id);
    const met = Number(row.met ?? 0);
    const breached = Number(row.breached ?? 0);
    rows.set(id, {
      userId: id,
      owner: text(row.owner),
      leadsOwned: Number(row.leads ?? 0),
      firstContactWithinSlaPercent: rate(met, met + breached),
      openOpportunities: 0,
      pipelineByCurrency: [],
      won: 0,
      lost: 0,
      winRatePercent: null,
      overdueFollowUps: overdueByUser.get(id) ?? 0,
      rankEligible: false,
    });
  }
  for (const raw of oppRows.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const id = text(row.user_id);
    const existing = rows.get(id) ?? {
      userId: id,
      owner: text(row.owner),
      leadsOwned: 0,
      firstContactWithinSlaPercent: null,
      openOpportunities: 0,
      pipelineByCurrency: [],
      won: 0,
      lost: 0,
      winRatePercent: null,
      overdueFollowUps: overdueByUser.get(id) ?? 0,
      rankEligible: false,
    };
    existing.openOpportunities += Number(row.open_count ?? 0);
    existing.won += Number(row.won ?? 0);
    existing.lost += Number(row.lost ?? 0);
    // One entry per currency, and never a sum across them.
    existing.pipelineByCurrency.push({
      currencyCode: text(row.currency),
      openValue: Number(row.open_value ?? 0),
    });
    rows.set(id, existing);
  }
  const list = [...rows.values()].map((row) => ({
    ...row,
    winRatePercent: rate(row.won, row.won + row.lost),
    rankEligible: row.won + row.lost >= filter.minVolume,
  }));
  list.sort((a, b) => b.openOpportunities - a.openOpportunities || b.leadsOwned - a.leadsOwned);
  return { rows: list, minimumVolume: filter.minVolume };
}

// ---- Teams, losses, forecast, follow-ups -------------------------------------

export interface TeamRow {
  teamId: string;
  teamName: string;
  members: number;
  leadsOwned: number;
  openOpportunities: number;
  won: number;
  lost: number;
  winRatePercent: number | null;
}

/**
 * Team performance, attributed by EFFECTIVE-DATED membership.
 *
 * `team_members` carries `effective_from` and `effective_to`, so a lead
 * captured in March belongs to the team its owner was in during March, not
 * to the team they joined in July. Attributing history to today's structure
 * rewrites the past every time somebody moves desk, and it is the reason
 * these joins compare the record's own date against the membership window.
 */
export async function teamPerformance(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<TeamRow[]> {
  const leadPop = await leadPopulation(db, userId, filter);
  const oppPop = await opportunityPopulation(db, userId, filter);
  const result = await db.execute({
    sql: `WITH lead_side AS (
            SELECT tm.team_id, COUNT(*) AS leads
            FROM ${leadPop.source}
            JOIN team_members tm ON tm.user_id = l.owner_user_id
              AND tm.effective_from <= l.captured_at
              AND (tm.effective_to IS NULL OR tm.effective_to >= l.captured_at)
            WHERE ${leadPop.where}
            GROUP BY tm.team_id
          ),
          opp_side AS (
            SELECT tm.team_id,
                   SUM(CASE WHEN o.status = 'OPEN' THEN 1 ELSE 0 END) AS open_count,
                   SUM(CASE WHEN o.status = 'WON' THEN 1 ELSE 0 END) AS won,
                   SUM(CASE WHEN o.status = 'LOST' THEN 1 ELSE 0 END) AS lost
            FROM ${oppPop.source}
            JOIN team_members tm ON tm.user_id = o.owner_user_id
              AND tm.effective_from <= o.created_at
              AND (tm.effective_to IS NULL OR tm.effective_to >= o.created_at)
            WHERE ${oppPop.where}
            GROUP BY tm.team_id
          )
          SELECT t.team_id, t.team_name,
                 (SELECT COUNT(*) FROM team_members m
                   WHERE m.team_id = t.team_id AND m.active = 1) AS members,
                 COALESCE((SELECT leads FROM lead_side WHERE lead_side.team_id = t.team_id), 0) AS leads,
                 COALESCE((SELECT open_count FROM opp_side WHERE opp_side.team_id = t.team_id), 0) AS open_count,
                 COALESCE((SELECT won FROM opp_side WHERE opp_side.team_id = t.team_id), 0) AS won,
                 COALESCE((SELECT lost FROM opp_side WHERE opp_side.team_id = t.team_id), 0) AS lost
          FROM teams t
          ORDER BY leads DESC, t.team_name`,
    args: [...leadPop.args, ...oppPop.args] as never[],
  });
  return result.rows.map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const won = Number(row.won ?? 0);
    const lost = Number(row.lost ?? 0);
    return {
      teamId: text(row.team_id),
      teamName: text(row.team_name),
      members: Number(row.members ?? 0),
      leadsOwned: Number(row.leads ?? 0),
      openOpportunities: Number(row.open_count ?? 0),
      won,
      lost,
      winRatePercent: rate(won, won + lost),
    };
  });
}

export interface LossRow {
  lostReasonId: string | null;
  reasonName: string;
  opportunities: number;
  lostValueByCurrency: { currencyCode: string; lostValue: number }[];
}

/**
 * Why opportunities were lost, from the configured reasons rather than from
 * free text. `lost_notes` is a person's sentence about one deal and is not a
 * dimension; `lost_reason_id` is the controlled value the business agreed.
 */
export async function lossAnalysis(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<LossRow[]> {
  const population = await opportunityPopulation(db, userId, filter);
  const result = await db.execute({
    sql: `SELECT o.lost_reason_id AS id,
            COALESCE(lr.reason_name, 'Not recorded') AS reason,
            o.currency_code AS currency,
            COUNT(*) AS opportunities,
            SUM(o.estimated_value) AS lost_value
          FROM ${population.source}
          LEFT JOIN lost_reasons lr ON lr.lost_reason_id = o.lost_reason_id
          WHERE ${population.where} AND o.status = 'LOST'
          GROUP BY o.lost_reason_id, o.currency_code
          ORDER BY opportunities DESC`,
    args: population.args as never[],
  });
  const byReason = new Map<string, LossRow>();
  for (const raw of result.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const key = text(row.reason);
    const existing = byReason.get(key) ?? {
      lostReasonId: nullableText(row.id),
      reasonName: key,
      opportunities: 0,
      lostValueByCurrency: [],
    };
    existing.opportunities += Number(row.opportunities ?? 0);
    existing.lostValueByCurrency.push({
      currencyCode: text(row.currency),
      lostValue: Number(row.lost_value ?? 0),
    });
    byReason.set(key, existing);
  }
  return [...byReason.values()];
}

export interface PipelineEstimate {
  /** Deliberately not called a forecast. See the note below. */
  label: string;
  note: string;
  rows: {
    currencyCode: string;
    opportunitiesClosingInPeriod: number;
    unweightedValue: number;
    weightedValue: number;
  }[];
}

export const PIPELINE_ESTIMATE_NOTE =
  'A pipeline estimate, not a revenue forecast. It is arithmetic on what people have entered: the opportunities whose estimated close date falls in the period, at their stored value and their stored probability. No model, no trend fitting, and no claim about what will actually be invoiced.';

/**
 * The deterministic estimate for a period.
 *
 * NOTHING HERE PREDICTS. There is no model, no seasonality and no
 * extrapolation, because a predictive number on this screen would be read as
 * a commitment and this application has neither the data nor the mandate to
 * make one. Two figures, both arithmetic: the value of the opportunities
 * expected to close, and the same value multiplied by the probability
 * somebody recorded.
 */
export async function pipelineEstimate(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<PipelineEstimate> {
  // The date basis here is the estimated close date, not the creation date,
  // and the label says so.
  const population = await opportunityPopulation(db, userId, filter, 'o.estimated_close_date');
  const result = await db.execute({
    sql: `SELECT o.currency_code AS currency, COUNT(*) AS opportunities,
            SUM(o.estimated_value) AS unweighted,
            SUM(o.estimated_value * o.probability) AS weighted
          FROM ${population.source}
          WHERE ${population.where} AND o.status = 'OPEN'
          GROUP BY o.currency_code ORDER BY unweighted DESC`,
    args: population.args as never[],
  });
  return {
    label: 'Pipeline estimate, by estimated close date',
    note: PIPELINE_ESTIMATE_NOTE,
    rows: result.rows.map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      return {
        currencyCode: text(row.currency),
        opportunitiesClosingInPeriod: Number(row.opportunities ?? 0),
        unweightedValue: Number(row.unweighted ?? 0),
        weightedValue: Number(row.weighted ?? 0),
      };
    }),
  };
}

export interface FollowUpHealth {
  dueToday: number;
  overdue: number;
  completedInPeriod: number;
  openOpportunitiesWithNoFollowUp: number;
  leadsWithNoFirstContact: number;
}

export async function followUpHealth(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<FollowUpHealth> {
  const leadPop = await leadPopulation(db, userId, filter);
  const oppPop = await opportunityPopulation(db, userId, filter);
  const today = now.slice(0, 10);
  const [activityRow, oppRow, leadRow] = await Promise.all([
    db.execute({
      sql: `SELECT
              SUM(CASE WHEN act.completed_at IS NULL
                        AND date(COALESCE(act.next_action_due, act.scheduled_at)) = ? THEN 1 ELSE 0 END) AS due_today,
              SUM(CASE WHEN act.completed_at IS NULL
                        AND COALESCE(act.next_action_due, act.scheduled_at) < ? THEN 1 ELSE 0 END) AS overdue,
              SUM(CASE WHEN act.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed
            FROM activities act`,
      args: [today, now],
    }),
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM ${oppPop.source}
            WHERE ${oppPop.where} AND o.status = 'OPEN'
              AND NOT EXISTS (SELECT 1 FROM activities act
                WHERE act.entity_type = 'OPPORTUNITY' AND act.entity_id = o.opportunity_id
                  AND act.completed_at IS NULL
                  AND COALESCE(act.next_action_due, act.scheduled_at) >= ?)`,
      args: [...oppPop.args, now] as never[],
    }),
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM ${leadPop.source}
            WHERE ${leadPop.where} AND l.first_contact_at IS NULL
              AND l.status NOT IN ('DISQUALIFIED','CONVERTED')`,
      args: leadPop.args as never[],
    }),
  ]);
  const activity = (activityRow.rows[0] ?? {}) as unknown as Record<string, unknown>;
  return {
    dueToday: Number(activity.due_today ?? 0),
    overdue: Number(activity.overdue ?? 0),
    completedInPeriod: Number(activity.completed ?? 0),
    openOpportunitiesWithNoFollowUp: Number(
      (oppRow.rows[0] as Record<string, unknown> | undefined)?.n ?? 0,
    ),
    leadsWithNoFirstContact: Number(
      (leadRow.rows[0] as Record<string, unknown> | undefined)?.n ?? 0,
    ),
  };
}

// ---- Trend -------------------------------------------------------------------

export interface CrmTrendBucket {
  bucket: string;
  newLeads: number;
  qualified: number;
  converted: number;
  opportunitiesCreated: number;
  won: number;
  lost: number;
  winRatePercent: number | null;
}

export async function trend(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
): Promise<CrmTrendBucket[]> {
  const leadPop = await leadPopulation(db, userId, filter);
  const oppPop = await opportunityPopulation(db, userId, filter);
  const leadBucket = bucketExpression('l.captured_at', filter.grain);
  const oppBucket = bucketExpression('o.created_at', filter.grain);
  const [leadRows, oppRows] = await Promise.all([
    db.execute({
      sql: `SELECT ${leadBucket} AS bucket, COUNT(*) AS new_leads,
              SUM(CASE WHEN l.status IN ('QUALIFIED','CONVERTED') THEN 1 ELSE 0 END) AS qualified,
              SUM(CASE WHEN l.status = 'CONVERTED' THEN 1 ELSE 0 END) AS converted
            FROM ${leadPop.source} WHERE ${leadPop.where} GROUP BY bucket ORDER BY bucket`,
      args: leadPop.args as never[],
    }),
    db.execute({
      sql: `SELECT ${oppBucket} AS bucket, COUNT(*) AS created,
              SUM(CASE WHEN o.status = 'WON' THEN 1 ELSE 0 END) AS won,
              SUM(CASE WHEN o.status = 'LOST' THEN 1 ELSE 0 END) AS lost
            FROM ${oppPop.source} WHERE ${oppPop.where} GROUP BY bucket ORDER BY bucket`,
      args: oppPop.args as never[],
    }),
  ]);
  const buckets = new Map<string, CrmTrendBucket>();
  const ensure = (key: string) => {
    const existing = buckets.get(key) ?? {
      bucket: key,
      newLeads: 0,
      qualified: 0,
      converted: 0,
      opportunitiesCreated: 0,
      won: 0,
      lost: 0,
      winRatePercent: null,
    };
    buckets.set(key, existing);
    return existing;
  };
  for (const raw of leadRows.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const entry = ensure(text(row.bucket));
    entry.newLeads = Number(row.new_leads ?? 0);
    entry.qualified = Number(row.qualified ?? 0);
    entry.converted = Number(row.converted ?? 0);
  }
  for (const raw of oppRows.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const entry = ensure(text(row.bucket));
    entry.opportunitiesCreated = Number(row.created ?? 0);
    entry.won = Number(row.won ?? 0);
    entry.lost = Number(row.lost ?? 0);
    entry.winRatePercent = rate(entry.won, entry.won + entry.lost);
  }
  return [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
}
