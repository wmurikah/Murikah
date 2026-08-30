/**
 * The reporting centre: parameterised views over the metric services phases
 * 20 to 24 already built.
 *
 * EVERY REPORT CALLS THOSE SERVICES. Not one figure is computed here. That
 * rule exists for a specific failure: a report that calculates finance
 * turnaround independently will disagree with the dashboard the first time
 * either definition is refined, the disagreement will surface in front of a
 * manager, and after that neither number is trusted. So a report is a shape
 * over a service's output and never a second query.
 *
 * The modules reused, named so a reviewer can check:
 *   repos/soPerformance.ts     sales orders, approvers, customers
 *   repos/poPerformance.ts     purchase order stages and approvers
 *   repos/crmAnalytics.ts      funnel, win rate, owner performance
 *   repos/serviceAnalytics.ts  service summary, SLA picture, category mix
 *   repos/auditTrail.ts        audit evidence
 *   analytics/filters.ts       the one filter object
 *   analytics/stats.ts         the median and P90 definitions
 *
 * SAVED REPORTS ARE URLS. The schema has no table for them and this batch may
 * not add one. A URL-serialisable filter is shareable, bookmarkable, survives
 * a paste into an email, and needs no storage. Persistent cross-device saved
 * reports would be a small dedicated migration and a separate decision.
 */
import type { Client } from '@libsql/client/web';
import type { AnalyticsFilter } from '../analytics/filters.ts';
import { MEDIAN_DEFINITION, P90_DEFINITION } from '../analytics/stats.ts';
import {
  soSummary,
  approverPerformance as soApprovers,
  customerPerformance,
} from '../repos/soPerformance.ts';
import {
  stagePerformance,
  approverPerformance as poApprovers,
  coverage as poCoverage,
} from '../repos/poPerformance.ts';
import { funnel, winRate, ownerPerformance } from '../repos/crmAnalytics.ts';
import { summary as serviceSummary, slaPicture, categoryMix } from '../repos/serviceAnalytics.ts';
import {
  canSeeCreditInformation,
  SALES_ORDER_VIEW,
  PURCHASE_ORDER_VIEW,
  OPPORTUNITIES_VIEW,
  CASES_VIEW,
  ACCOUNTS_VIEW,
  AUDIT_VIEW,
} from '../permissions.ts';

export type ReportFamily =
  | 'CUSTOMER'
  | 'CRM'
  | 'SERVICE'
  | 'SALES_ORDER'
  | 'PURCHASE_ORDER'
  | 'SLA'
  | 'AUDIT';

export const FAMILY_LABEL: Readonly<Record<ReportFamily, string>> = {
  CUSTOMER: 'Customer',
  CRM: 'CRM',
  SERVICE: 'Customer service',
  SALES_ORDER: 'Sales orders',
  PURCHASE_ORDER: 'Purchase orders',
  SLA: 'SLA',
  AUDIT: 'Audit',
};

/**
 * The filter fields a report actually uses.
 *
 * Declared, so the interface shows only the relevant ones. A date range on a
 * report that ignores dates is worse than no control: somebody sets it, the
 * numbers do not move, and they conclude the report is broken.
 */
export type ReportParameter =
  | 'dateRange'
  | 'country'
  | 'affiliate'
  | 'businessUnit'
  | 'account'
  | 'product'
  | 'owner'
  | 'team'
  | 'currency'
  | 'minVolume'
  | 'grain';

/**
 * A KPI's four facts, carried with the report rather than in a wiki.
 *
 * The same four the dashboards carry, and deliberately the same words: a
 * definition that reads differently in two places is two definitions as far
 * as a reader is concerned, whatever the code does.
 */
export interface KpiDefinition {
  name: string;
  definition: string;
  /** What the figure is out of. "Not a rate" where it is a count. */
  denominator: string;
  /** Which timestamp the date range filters on. */
  dateBasis: string;
}

export type CellValue = string | number | null;

export interface ReportColumn {
  key: string;
  label: string;
  /** Right-aligned and tabular in the interface, and unquoted in exports. */
  numeric?: boolean;
  /** A short note under the header, for a column that needs one. */
  note?: string;
}

export interface ReportRun {
  columns: ReportColumn[];
  rows: Record<string, CellValue>[];
  /** Sentences the reader needs beside the table. Coverage, wording, caveats. */
  notes: string[];
  /**
   * Per-row drill-through. Given a row, where does the live record live?
   * Null where a row is an aggregate with no single record behind it.
   */
  hrefFor?: (row: Record<string, CellValue>) => string | null;
}

export interface ReportDefinition {
  id: string;
  family: ReportFamily;
  name: string;
  description: string;
  /** The permission a caller needs. The report refuses without it. */
  permission: string;
  parameters: ReportParameter[];
  kpis: KpiDefinition[];
  /** The module this report reads, named in the interface and the PR. */
  source: string;
  run: (
    db: Client,
    userId: string,
    filter: AnalyticsFilter,
    now: string,
    permissions: readonly string[],
  ) => Promise<ReportRun>;
}

/** Minutes as a number, or null. Never zero for absent. */
const mins = (value: number | null): number | null =>
  value === null ? null : Math.round(value * 10) / 10;

const DATE_BASIS = {
  soCreated: 'sales_orders.order_created_at',
  poCreated: 'purchase_orders.po_created_at',
  caseRaised: 'service_cases.raised_at',
  leadCaptured: 'leads.captured_at',
  auditEvent: 'audit_events.event_at',
} as const;

export const REPORTS: ReportDefinition[] = [
  // ---- Sales orders --------------------------------------------------------
  {
    id: 'so-summary',
    family: 'SALES_ORDER',
    name: 'Sales order performance summary',
    description:
      'The same figures as the sales order performance dashboard, for the same filter, from the same service.',
    permission: SALES_ORDER_VIEW,
    parameters: ['dateRange', 'country', 'affiliate', 'businessUnit', 'account', 'currency'],
    source: 'repos/soPerformance.ts soSummary',
    kpis: [
      {
        name: 'Orders',
        definition: 'Sales orders whose creation date falls inside the selected range and scope.',
        denominator: 'Not a rate.',
        dateBasis: DATE_BASIS.soCreated,
      },
      {
        name: 'Finance turnaround, median',
        definition: `Minutes from the finance stage becoming actionable to its completion. ${MEDIAN_DEFINITION}`,
        denominator: 'Completed finance stages only. Pending stages are excluded and counted.',
        dateBasis: DATE_BASIS.soCreated,
      },
      {
        name: 'Credit turnaround',
        definition:
          'Minutes on the credit stage, over orders that required credit approval only. An order not requiring credit reads "Not required", never zero.',
        denominator: 'Orders where credit_exception_required = 1.',
        dateBasis: DATE_BASIS.soCreated,
      },
      {
        name: 'SLA compliance',
        definition:
          'Settled SLA timers on these orders that were met, as a percentage of settled timers. Running timers are not counted either way.',
        denominator: 'Settled SLA instances.',
        dateBasis: DATE_BASIS.soCreated,
      },
    ],
    async run(db, userId, filter, now) {
      const summary = await soSummary(db, userId, filter, now);
      const credit = summary.credit;
      const rows: Record<string, CellValue>[] = [
        { metric: 'Orders in scope', value: summary.orders, coverage: 'All selected orders' },
        // ELAPSED AND ACCOUNTABLE ARE TWO ROWS, NEVER ONE. Elapsed is what
        // the customer waited; accountable is elapsed less the minutes the
        // SLA engine recorded as paused. Presenting either as the other is
        // the error the phase 20 service exists to prevent.
        {
          metric: 'Finance turnaround, median elapsed minutes',
          value: mins(summary.finance.elapsed.medianMinutes),
          coverage: `${summary.finance.elapsed.measured} of ${summary.finance.elapsed.total} measured`,
        },
        {
          metric: 'Finance turnaround, median accountable minutes',
          value: mins(summary.finance.accountable.medianMinutes),
          coverage: `Pause-adjusted. ${summary.finance.slaCovered} of the measured orders carry an SLA instance for this stage.`,
        },
        {
          metric: 'Finance turnaround, P90 elapsed minutes',
          value: mins(summary.finance.elapsed.p90Minutes),
          coverage: `${summary.finance.elapsed.measured} of ${summary.finance.elapsed.total} measured`,
        },
        {
          metric: 'Orders requiring credit approval',
          value: credit.ordersRequiringCredit,
          coverage: `Out of ${credit.ordersInSelection} in the selection. This is the denominator for every credit figure below.`,
        },
        {
          metric: 'Orders not requiring credit approval',
          value: credit.ordersNotRequiringCredit,
          coverage: 'Excluded from the credit denominator entirely. Never counted as a zero.',
        },
        {
          metric: 'Credit turnaround, median elapsed minutes',
          value: mins(credit.turnaround.elapsed.medianMinutes),
          coverage: `${credit.turnaround.elapsed.measured} of ${credit.ordersRequiringCredit} orders requiring credit`,
        },
        {
          metric: 'Order to invoice, median minutes',
          value: mins(summary.fulfilment.orderToInvoice.medianMinutes),
          coverage: `${summary.fulfilment.orderToInvoice.measured} of ${summary.fulfilment.orderToInvoice.total} measured`,
        },
        {
          metric: 'Order to loading authority, median minutes',
          value: mins(summary.fulfilment.orderToLoadingAuthority.medianMinutes),
          coverage: `${summary.fulfilment.orderToLoadingAuthority.measured} of ${summary.fulfilment.orderToLoadingAuthority.total} measured. A separate metric from order to invoice, on a separate population.`,
        },
        {
          metric: 'SLA compliance, per cent',
          value: summary.slaCompliancePercent,
          coverage: `${summary.slaMeasured} settled timers`,
        },
      ];
      for (const currency of summary.currencies) {
        rows.push({
          metric: `Order value, ${currency.currencyCode ?? 'currency not recorded'}`,
          // null stays null. The extract carries no commercial value on a
          // sales order, so this is very often unknown, and a zero would be a
          // claim that the customer ordered nothing.
          value: currency.totalValue,
          coverage: `${currency.orders} orders. Currencies are never summed.`,
        });
      }
      return {
        columns: [
          { key: 'metric', label: 'Metric' },
          { key: 'value', label: 'Value', numeric: true },
          { key: 'coverage', label: 'Coverage' },
        ],
        rows,
        notes: [
          'Every figure comes from repos/soPerformance.ts soSummary, the same service the sales order performance dashboard calls.',
          'A blank value is unknown, not zero. The coverage column says how many records carried the timestamp the figure needs.',
          'Values are grouped by currency and never summed across them: there is no rate in this system to sum them with.',
        ],
      };
    },
  },
  {
    id: 'so-approver-performance',
    family: 'SALES_ORDER',
    name: 'Sales order approver performance',
    description:
      'One row per person per stage. A person working two processes appears twice and is never blended into one figure.',
    permission: SALES_ORDER_VIEW,
    parameters: ['dateRange', 'country', 'affiliate', 'businessUnit', 'minVolume'],
    source: 'repos/soPerformance.ts approverPerformance',
    kpis: [
      {
        name: 'Median minutes on stage',
        definition: `Minutes from the stage becoming actionable to that person completing it. ${MEDIAN_DEFINITION}`,
        denominator: 'Stages that person completed, in this process, in this scope.',
        dateBasis: DATE_BASIS.soCreated,
      },
      {
        name: 'P90 minutes',
        definition: P90_DEFINITION,
        denominator: 'The same completed stages.',
        dateBasis: DATE_BASIS.soCreated,
      },
      {
        name: 'Rank eligibility',
        definition:
          'A person is ranked only above the stated minimum volume. Below it the figures are shown and no rank is given, because one transaction does not outrank three hundred.',
        denominator: 'Transactions on that stage.',
        dateBasis: DATE_BASIS.soCreated,
      },
    ],
    async run(db, userId, filter, now) {
      const result = await soApprovers(db, userId, filter, now);
      const rows = result.rows;
      return {
        columns: [
          { key: 'approver', label: 'Person' },
          { key: 'processType', label: 'Process', note: 'Never blended across processes' },
          { key: 'stageName', label: 'Stage' },
          { key: 'affiliateName', label: 'Affiliate' },
          { key: 'transactions', label: 'Volume', numeric: true },
          { key: 'medianMinutes', label: 'Median minutes', numeric: true },
          { key: 'p90Minutes', label: 'P90 minutes', numeric: true },
          { key: 'withinSlaPercent', label: 'Within SLA %', numeric: true },
          { key: 'pending', label: 'Pending', numeric: true },
          { key: 'rankEligible', label: 'Ranked' },
        ],
        rows: rows.map((row) => ({
          approver: row.approver,
          processType: row.processType,
          stageName: row.stageName,
          affiliateName: row.affiliateName,
          transactions: row.transactions,
          medianMinutes: mins(row.medianMinutes),
          p90Minutes: mins(row.p90Minutes),
          withinSlaPercent: row.withinSlaPercent,
          pending: row.pending,
          rankEligible: row.rankEligible ? 'Yes' : `Below the minimum of ${result.minimumVolume}`,
        })),
        notes: [
          'Every row carries its process, its stage, its scope and its volume. There is no single "average approval time by employee" anywhere in this report, because blending a person’s sales order and purchase order work produces a number that means nothing.',
          `A person is ranked only at or above ${result.minimumVolume} transactions on that stage. Below it the figures are shown without a rank.`,
        ],
      };
    },
  },

  // ---- Purchase orders -----------------------------------------------------
  {
    id: 'po-stage-performance',
    family: 'PURCHASE_ORDER',
    name: 'Purchase order stage performance',
    description:
      'Every approval stage the selected orders actually used, in sequence, with its own turnaround. Three levels or seven, the query reads what exists.',
    permission: PURCHASE_ORDER_VIEW,
    parameters: ['dateRange', 'country', 'affiliate', 'businessUnit'],
    source: 'repos/poPerformance.ts stagePerformance and coverage',
    kpis: [
      {
        name: 'Median minutes on stage',
        definition: `Minutes from the stage becoming actionable to its completion. ${MEDIAN_DEFINITION}`,
        denominator: 'Completed stage instances. A level nobody used has no row at all.',
        dateBasis: DATE_BASIS.poCreated,
      },
    ],
    async run(db, userId, filter, now) {
      const [stages, cover] = await Promise.all([
        stagePerformance(db, userId, filter, now),
        poCoverage(db, userId, filter, now),
      ]);
      return {
        columns: [
          { key: 'sequenceNo', label: 'Level', numeric: true },
          { key: 'stageName', label: 'Stage' },
          { key: 'recorded', label: 'Recorded', numeric: true },
          { key: 'completed', label: 'Completed', numeric: true },
          { key: 'pending', label: 'Pending', numeric: true },
          { key: 'medianMinutes', label: 'Median minutes', numeric: true },
          { key: 'p90Minutes', label: 'P90 minutes', numeric: true },
        ],
        rows: stages.map((row) => ({
          sequenceNo: row.sequenceNo,
          stageName: row.stageName,
          recorded: row.recorded,
          completed: row.completed,
          pending: row.pending,
          medianMinutes: mins(row.medianMinutes),
          p90Minutes: mins(row.p90Minutes),
        })),
        notes: [
          // Coverage BEFORE durations, which is the order the phase 21 page
          // uses and for the same reason: a median over four records is a
          // different claim from a median over four hundred.
          'Coverage first, because a duration measured over a handful of records is a different claim from one measured over all of them.',
          ...cover.map(
            (row) =>
              `${row.label}: ${row.present} of ${row.total}${
                row.percent === null ? '' : ` (${row.percent}%)`
              }. ${row.note}`,
          ),
          'A stage nobody used has no row here at all, rather than a row of zeroes that would read as a stage everybody passed instantly.',
        ],
      };
    },
  },
  {
    id: 'po-approver-performance',
    family: 'PURCHASE_ORDER',
    name: 'Purchase order approver performance',
    description:
      'One row per person per stage, with the authority context derived from the entities their transactions actually span.',
    permission: PURCHASE_ORDER_VIEW,
    parameters: ['dateRange', 'country', 'affiliate', 'businessUnit', 'minVolume'],
    source: 'repos/poPerformance.ts approverPerformance',
    kpis: [
      {
        name: 'Median minutes on stage',
        definition: `Minutes from the stage becoming actionable to that person completing it. ${MEDIAN_DEFINITION}`,
        denominator: 'Stages that person completed on purchase orders in this scope.',
        dateBasis: DATE_BASIS.poCreated,
      },
    ],
    async run(db, userId, filter, now) {
      const result = await poApprovers(db, userId, filter, now);
      const rows = result.rows;
      return {
        columns: [
          { key: 'approver', label: 'Person' },
          { key: 'processType', label: 'Process' },
          { key: 'stageName', label: 'Stage' },
          { key: 'authorityContext', label: 'Authority context', note: 'Derived, not a job title' },
          { key: 'affiliatesCovered', label: 'Affiliates', numeric: true },
          { key: 'transactions', label: 'Volume', numeric: true },
          { key: 'medianMinutes', label: 'Median minutes', numeric: true },
          { key: 'p90Minutes', label: 'P90 minutes', numeric: true },
          { key: 'pending', label: 'Pending', numeric: true },
          { key: 'rankEligible', label: 'Ranked' },
        ],
        rows: rows.map((row) => ({
          approver: row.approver,
          // Stated on every row rather than inferred from the report's title,
          // so a row cut and pasted out of here still says what it measures.
          processType: 'PURCHASE_ORDER',
          stageName: row.stageName,
          authorityContext: row.authorityContext,
          affiliatesCovered: row.affiliatesCovered,
          transactions: row.transactions,
          medianMinutes: mins(row.medianMinutes),
          p90Minutes: mins(row.p90Minutes),
          pending: row.pending,
          rankEligible: row.rankEligible ? 'Yes' : `Below the minimum of ${result.minimumVolume}`,
        })),
        notes: [
          'The authority context is derived from the affiliates a person’s transactions actually span. It is never read from a role or a job title.',
          'Sales order work is not in this report and is never added to it.',
        ],
      };
    },
  },

  // ---- CRM ------------------------------------------------------------------
  {
    id: 'crm-funnel',
    family: 'CRM',
    name: 'Lead funnel and win rate',
    description: 'The funnel with its stated denominators, and the win rate over decided deals.',
    permission: OPPORTUNITIES_VIEW,
    parameters: ['dateRange', 'country', 'affiliate', 'businessUnit', 'owner', 'team'],
    source: 'repos/crmAnalytics.ts funnel and winRate',
    kpis: [
      {
        name: 'Qualification rate',
        definition:
          'Leads qualified as a percentage of every lead in the selection. A disqualified lead was still a chance to qualify one.',
        denominator: 'All leads captured in the range.',
        dateBasis: DATE_BASIS.leadCaptured,
      },
      {
        name: 'Conversion rate',
        definition:
          'Leads converted as a percentage of qualified leads only. A lead that never qualified was never a candidate for conversion.',
        denominator: 'Qualified leads.',
        dateBasis: DATE_BASIS.leadCaptured,
      },
      {
        name: 'Win rate',
        definition:
          'Won opportunities as a percentage of decided opportunities. Open opportunities are excluded from both halves; adding one does not move the rate.',
        denominator: 'Won plus lost.',
        dateBasis: DATE_BASIS.leadCaptured,
      },
    ],
    async run(db, userId, filter) {
      const [shape, win] = await Promise.all([
        funnel(db, userId, filter),
        winRate(db, userId, filter),
      ]);
      const rows: Record<string, CellValue>[] = shape.steps.map((step) => ({
        stage: step.step,
        count: step.leads,
        rate: step.conversionPercent,
        basis: step.denominator,
      }));
      rows.push(
        {
          stage: 'Qualification rate',
          count: shape.qualificationDenominator,
          rate: shape.qualificationRatePercent,
          basis: `${shape.qualificationDenominator} leads in the selection. A disqualified lead was still a chance to qualify one.`,
        },
        {
          stage: 'Conversion rate',
          count: shape.conversionDenominator,
          rate: shape.conversionRatePercent,
          basis: `${shape.conversionDenominator} qualified leads. A lead that never qualified was never a candidate for conversion.`,
        },
        {
          stage: 'Win rate',
          count: win.won,
          rate: win.winRatePercent,
          basis: `${win.denominator} decided (${win.won} won, ${win.lost} lost). ${win.open} open, excluded from both halves.`,
        },
      );
      return {
        columns: [
          { key: 'stage', label: 'Step' },
          { key: 'count', label: 'Count', numeric: true },
          { key: 'rate', label: 'Rate %', numeric: true },
          { key: 'basis', label: 'Denominator' },
        ],
        rows,
        notes: [
          'Every rate states what it is out of, in the row itself, because a percentage without a denominator is not a measurement.',
          'A blank rate means the denominator was zero. It is not a zero rate.',
        ],
      };
    },
  },
  {
    id: 'crm-owner-performance',
    family: 'CRM',
    name: 'Owner performance',
    description:
      'Ordered by portfolio size, not by money. Pipeline is grouped by currency and never summed.',
    permission: OPPORTUNITIES_VIEW,
    parameters: ['dateRange', 'country', 'affiliate', 'businessUnit', 'team', 'minVolume'],
    source: 'repos/crmAnalytics.ts ownerPerformance',
    kpis: [
      {
        name: 'Win rate',
        definition: 'Won as a percentage of that person’s decided opportunities.',
        denominator: 'Their won plus lost.',
        dateBasis: DATE_BASIS.leadCaptured,
      },
      {
        name: 'First contact within SLA',
        definition:
          'Their leads whose first-contact timer was met, as a percentage of their settled first-contact timers.',
        denominator: 'Settled first-contact SLA instances on their leads.',
        dateBasis: DATE_BASIS.leadCaptured,
      },
    ],
    async run(db, userId, filter, now) {
      const owners = await ownerPerformance(db, userId, filter, now);
      const rows = owners.rows;
      return {
        columns: [
          { key: 'owner', label: 'Person' },
          { key: 'leadsOwned', label: 'Leads owned', numeric: true },
          { key: 'firstContactWithinSlaPercent', label: 'First contact in SLA %', numeric: true },
          { key: 'openOpportunities', label: 'Open opportunities', numeric: true },
          { key: 'pipeline', label: 'Open pipeline by currency' },
          { key: 'won', label: 'Won', numeric: true },
          { key: 'lost', label: 'Lost', numeric: true },
          { key: 'winRatePercent', label: 'Win rate %', numeric: true },
          { key: 'overdueFollowUps', label: 'Overdue follow-ups', numeric: true },
          { key: 'rankEligible', label: 'Ranked' },
        ],
        rows: rows.map((row) => ({
          owner: row.owner,
          leadsOwned: row.leadsOwned,
          firstContactWithinSlaPercent: row.firstContactWithinSlaPercent,
          openOpportunities: row.openOpportunities,
          pipeline:
            row.pipelineByCurrency.length === 0
              ? 'None'
              : row.pipelineByCurrency
                  .map((c) => `${c.currencyCode} ${c.openValue.toLocaleString('en-KE')}`)
                  .join('; '),
          won: row.won,
          lost: row.lost,
          winRatePercent: row.winRatePercent,
          overdueFollowUps: row.overdueFollowUps,
          rankEligible: row.rankEligible ? 'Yes' : `Below the minimum of ${owners.minimumVolume}`,
        })),
        notes: [
          'Ordered by portfolio size. A table sorted by money says only who was given the biggest territory.',
          'Pipeline is one figure per currency. There is no total, because there is no rate in this system to make one with.',
        ],
      };
    },
  },

  // ---- Customer service -----------------------------------------------------
  {
    id: 'service-summary',
    family: 'SERVICE',
    name: 'Customer service summary',
    description:
      'First response, resolution as two distinct durations, and satisfaction with its sample size.',
    permission: CASES_VIEW,
    parameters: ['dateRange', 'country', 'affiliate', 'businessUnit', 'account', 'team'],
    source: 'repos/serviceAnalytics.ts summary',
    kpis: [
      {
        name: 'Resolution, elapsed',
        definition:
          'Wall-clock minutes from the case being raised to it being resolved. What the customer experienced.',
        denominator: 'Resolved cases carrying both timestamps.',
        dateBasis: DATE_BASIS.caseRaised,
      },
      {
        name: 'Resolution, accountable',
        definition:
          'Elapsed minutes less the external timer’s recorded pause. What the SLA holds somebody to. Distinct from elapsed and never substituted for it.',
        denominator: 'The same resolved cases.',
        dateBasis: DATE_BASIS.caseRaised,
      },
      {
        name: 'First response within SLA',
        definition: 'Settled first-response timers that were met, as a percentage of settled ones.',
        denominator: 'Settled FIRST_RESPONSE SLA instances.',
        dateBasis: DATE_BASIS.caseRaised,
      },
      {
        name: 'Satisfaction',
        definition:
          'The mean CSAT score of the responses received. Non-responses are excluded, never imputed as a middle value.',
        denominator: 'Survey responses received.',
        dateBasis: DATE_BASIS.caseRaised,
      },
    ],
    async run(db, userId, filter) {
      const s = await serviceSummary(db, userId, filter);
      return {
        columns: [
          { key: 'metric', label: 'Metric' },
          { key: 'value', label: 'Value', numeric: true },
          { key: 'coverage', label: 'Coverage' },
        ],
        rows: [
          { metric: 'Cases opened', value: s.casesOpened, coverage: 'All selected cases' },
          { metric: 'Open backlog', value: s.openBacklog, coverage: 'Unresolved at this moment' },
          {
            metric: 'First response, median minutes',
            value: mins(s.firstResponseMedianMinutes),
            coverage: `${s.firstResponseMeasured} measured, ${s.awaitingFirstResponse} still awaiting one`,
          },
          {
            metric: 'First response within SLA, per cent',
            value: s.firstResponseWithinSlaPercent,
            coverage: `${s.firstResponseMeasured} settled timers`,
          },
          {
            metric: 'Resolution elapsed, median minutes',
            value: mins(s.medianResolutionElapsedMinutes),
            coverage: `${s.resolutionMeasured} of ${s.resolutionTotal} resolved cases measured`,
          },
          {
            metric: 'Resolution accountable, median minutes',
            value: mins(s.medianResolutionAccountableMinutes),
            coverage: 'The same cases, less recorded pause',
          },
          {
            metric: 'External SLA compliance, per cent',
            value: s.externalSlaCompliancePercent,
            coverage: `${s.externalSlaMeasured} settled external timers`,
          },
          {
            metric: 'CSAT',
            value: s.csatScore,
            coverage: `${s.csatResponses} responses. Non-responses excluded, never imputed.`,
          },
        ],
        notes: [
          'Elapsed and accountable are two distinct labelled durations. Neither is ever presented as the other.',
          'A blank value means the denominator was zero or no record carried the timestamp. It is not a zero.',
        ],
      };
    },
  },
  {
    id: 'service-category-mix',
    family: 'SERVICE',
    name: 'Case category mix',
    description:
      'Counted on the structured category. Free-text root cause is never counted as a dimension.',
    permission: CASES_VIEW,
    parameters: ['dateRange', 'country', 'affiliate', 'businessUnit', 'account'],
    source: 'repos/serviceAnalytics.ts categoryMix',
    kpis: [
      {
        name: 'Cases by category',
        definition:
          'Cases grouped on case_category_id. Two people describing the same fault in two sentences would become two causes, so free text is never a bucket.',
        denominator: 'Not a rate.',
        dateBasis: DATE_BASIS.caseRaised,
      },
    ],
    async run(db, userId, filter) {
      const rows = await categoryMix(db, userId, filter);
      return {
        columns: [
          { key: 'categoryName', label: 'Category' },
          { key: 'subcategoryName', label: 'Subcategory' },
          { key: 'cases', label: 'Cases', numeric: true },
          { key: 'complaints', label: 'Complaints', numeric: true },
          { key: 'medianResolutionElapsedMinutes', label: 'Median elapsed minutes', numeric: true },
          { key: 'breached', label: 'Breached', numeric: true },
        ],
        rows: rows.map((row) => ({
          categoryName: row.categoryName,
          subcategoryName: row.subcategoryName,
          cases: row.cases,
          complaints: row.complaints,
          medianResolutionElapsedMinutes: mins(row.medianResolutionElapsedMinutes),
          breached: row.breached,
        })),
        notes: [
          'Grouped on the structured category only. `root_cause` is free text, is searchable on the case itself, and is never counted here.',
        ],
      };
    },
  },

  // ---- Customer -------------------------------------------------------------
  {
    id: 'customer-performance',
    family: 'CUSTOMER',
    name: 'Customer performance',
    description:
      'One row per customer: order volume, fulfilment turnaround and SLA compliance on their orders.',
    permission: ACCOUNTS_VIEW,
    parameters: ['dateRange', 'country', 'affiliate', 'businessUnit', 'minVolume'],
    source: 'repos/soPerformance.ts customerPerformance',
    kpis: [
      {
        name: 'Order to invoice, median',
        definition: `Minutes from order creation to the invoice timestamp. ${MEDIAN_DEFINITION}`,
        denominator: 'Their orders carrying an invoice timestamp.',
        dateBasis: DATE_BASIS.soCreated,
      },
      {
        name: 'Credit exception rate',
        definition:
          'Their orders requiring credit approval as a percentage of their orders. Shown only to a caller holding CREDIT.EXCEPTION.APPROVE.',
        denominator: 'Their orders in scope.',
        dateBasis: DATE_BASIS.soCreated,
      },
    ],
    async run(db, userId, filter, now, permissions) {
      // The service takes a boolean, not a permission list: the decision of
      // WHETHER this caller may see credit information is made here, once,
      // by the same helper the dashboard uses.
      const rows = await customerPerformance(
        db,
        userId,
        filter,
        now,
        canSeeCreditInformation(permissions),
      );
      const creditVisible = canSeeCreditInformation(permissions);
      return {
        columns: [
          { key: 'customerName', label: 'Customer' },
          { key: 'orders', label: 'Orders', numeric: true },
          { key: 'medianOrderToInvoiceMinutes', label: 'Order to invoice, median', numeric: true },
          ...(creditVisible
            ? [{ key: 'creditExceptionRatePercent', label: 'Credit exception %', numeric: true }]
            : []),
          { key: 'slaCompliancePercent', label: 'SLA compliance %', numeric: true },
        ],
        rows: rows.map((row) => ({
          accountId: row.accountId,
          customerName: row.customerName,
          orders: row.orders,
          medianOrderToInvoiceMinutes: mins(row.medianOrderToInvoiceMinutes),
          ...(creditVisible ? { creditExceptionRatePercent: row.creditExceptionRatePercent } : {}),
          slaCompliancePercent: row.slaCompliancePercent,
        })),
        notes: creditVisible
          ? [
              'The credit column is present because you hold CREDIT.EXCEPTION.APPROVE. A caller without it does not see an empty column; the column is absent.',
            ]
          : [
              'Credit information is not in this report because you do not hold CREDIT.EXCEPTION.APPROVE. The column is absent rather than empty, so nothing is implied about what is behind it.',
            ],
        hrefFor: (row) =>
          typeof row.accountId === 'string' ? `/app/customers/${row.accountId}` : null,
      };
    },
  },

  // ---- SLA ------------------------------------------------------------------
  {
    id: 'sla-compliance',
    family: 'SLA',
    name: 'SLA compliance',
    description:
      'External and internal timers reported separately, with the settled-timer denominator stated.',
    permission: CASES_VIEW,
    parameters: ['dateRange', 'country', 'affiliate', 'businessUnit', 'team'],
    source: 'repos/serviceAnalytics.ts slaPicture',
    kpis: [
      {
        name: 'Compliance',
        definition:
          'Settled timers met as a percentage of settled timers. A running timer is neither met nor breached and is excluded from both halves.',
        denominator: 'Settled SLA instances of that type.',
        dateBasis: DATE_BASIS.caseRaised,
      },
    ],
    async run(db, userId, filter, now) {
      const picture = await slaPicture(db, userId, filter, now);
      const line = (
        label: string,
        side: { met: number; breached: number; atRisk: number; compliancePercent: number | null },
      ): Record<string, CellValue> => ({
        slaType: label,
        settled: side.met + side.breached,
        met: side.met,
        breached: side.breached,
        atRisk: side.atRisk,
        compliancePercent: side.compliancePercent,
      });
      return {
        columns: [
          { key: 'slaType', label: 'Timer type' },
          { key: 'settled', label: 'Settled', numeric: true },
          { key: 'met', label: 'Met', numeric: true },
          { key: 'breached', label: 'Breached', numeric: true },
          {
            key: 'atRisk',
            label: 'At risk',
            numeric: true,
            note: 'Still running, so neither met nor breached',
          },
          { key: 'compliancePercent', label: 'Compliance %', numeric: true },
        ],
        rows: [
          line('External, what the customer was promised', picture.external),
          line('Internal, which stage or team held it', picture.internal),
        ],
        notes: [
          'External and internal timers are separate rows and are never averaged together: they measure a promise to a customer and an internal target, which are different things.',
          'An at-risk timer is still running and is in neither half of the rate. Counting it as met would flatter the figure and counting it as breached would defame it.',
          picture.attributionNote,
          picture.medianBreachMinutes === null
            ? 'No breach in this selection carried the timestamps needed to measure how far past target it ran.'
            : `Median overrun on a breach: ${Math.round(picture.medianBreachMinutes)} minutes past target.`,
        ],
      };
    },
  },

  // ---- Audit ----------------------------------------------------------------
  {
    id: 'audit-evidence',
    family: 'AUDIT',
    name: 'Audit evidence',
    description:
      'Filtered audit rows. The full workspace, its scope and its security gate live under Administration; this is the same data as a report.',
    permission: AUDIT_VIEW,
    parameters: ['dateRange'],
    source: 'repos/auditTrail.ts listAuditEvents',
    kpis: [
      {
        name: 'Events',
        definition:
          'Audit rows inside your own audit scope and the selected dates. Security events are excluded unless you hold AUDIT.EVENTS.SECURITY_VIEW.',
        denominator: 'Not a rate.',
        dateBasis: DATE_BASIS.auditEvent,
      },
    ],
    async run(db, userId, filter) {
      // Imported lazily so the report catalogue does not pull the audit
      // repository into every page that lists report names.
      const { listAuditEvents, parseAuditFilter } = await import('../repos/auditTrail.ts');
      const params = new URLSearchParams();
      if (filter.from !== null) params.set('from', filter.from);
      if (filter.to !== null) params.set('to', filter.to);
      const auditFilter = parseAuditFilter(params, new Date());
      const page = await listAuditEvents(db, userId, auditFilter);
      return {
        columns: [
          { key: 'eventAt', label: 'When (UTC)' },
          { key: 'actorName', label: 'Who' },
          { key: 'eventLabel', label: 'Event' },
          { key: 'entityLabel', label: 'Record' },
          { key: 'action', label: 'Action' },
          { key: 'changeSummary', label: 'What changed' },
        ],
        rows: page.items.map((row) => ({
          auditEventId: row.auditEventId,
          eventAt: row.eventAt,
          actorName: row.actorName,
          eventLabel: row.eventLabel,
          entityLabel: row.entityLabel ?? row.entityId,
          action: row.action,
          changeSummary: row.changeSummary,
        })),
        notes: [
          `${page.total} events matched. This report shows the first ${page.pageSize}; the audit workspace pages through all of them.`,
          page.securityIncluded
            ? 'Security events are included because you hold AUDIT.EVENTS.SECURITY_VIEW.'
            : 'Security events were not searched, because you do not hold AUDIT.EVENTS.SECURITY_VIEW. They are not hidden rows in the count above.',
        ],
        hrefFor: (row) =>
          typeof row.auditEventId === 'string'
            ? `/app/administration/audit/${row.auditEventId}`
            : null,
      };
    },
  },
];

export function reportById(id: string): ReportDefinition | null {
  return REPORTS.find((report) => report.id === id) ?? null;
}

/** The reports a principal may actually run, by family. */
export function reportsFor(permissions: readonly string[]): ReportDefinition[] {
  return REPORTS.filter((report) => permissions.includes(report.permission));
}
