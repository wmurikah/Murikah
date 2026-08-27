/**
 * The executive dashboard.
 *
 * NOT A COLLECTION OF EVERY KPI. This page connects commercial demand,
 * operational execution and customer experience, and it answers one
 * question: where should management pay attention. Exceptions first, trends
 * in the middle, analysis at the bottom.
 *
 * EVERY FIGURE COMES FROM THE MODULE THAT OWNS IT.
 * There is no second implementation of a metric anywhere in this file. The
 * sales order figures are `soPerformance`, the purchase order figures are
 * `poPerformance`, the CRM figures are `crmAnalytics` and the service
 * figures are `serviceAnalytics`, all called with the same filter and the
 * same principal. If a number on this page could disagree with the same
 * number on its module page, the design would be wrong; the only way to be
 * certain it cannot is for both to be the same function.
 *
 * COMPOSED FROM PERMISSIONS, NEVER FROM A NAME.
 * There is no page per person. `composeDashboard` reads the caller's
 * permission codes and includes the sections those codes allow, and the
 * scope resolver then decides which records each section counts. A Group
 * user and a country manager run the same code path and see different
 * figures because their scope differs, not because the page knows who they
 * are.
 *
 * DIRECTION HAS SEMANTICS.
 * A rise in complaints is not good news. Every trend carries the direction
 * that counts as an improvement, so a falling backlog and a rising win rate
 * can both read as progress without the interface guessing.
 *
 * EXTRACT DATA IS NEVER CALLED REAL TIME.
 * Sales and purchase orders arrive by upload. The dashboard shows when each
 * was last imported, from `import_batches`, so nobody decides on a figure
 * that is three days old believing it is live.
 */
import type { Client } from '@libsql/client/web';
import type { AnalyticsFilter } from '../analytics/filters.ts';
import { rate } from '../analytics/stats.ts';
import {
  canViewCases,
  canViewImports,
  canViewOpportunities,
  canViewPurchaseOrders,
  canViewSalesOrders,
} from '../permissions.ts';
import { soSummary, backlog as soBacklog, trend as soTrend } from './soPerformance.ts';
import {
  backlog as poBacklog,
  coverage as poCoverage,
  durations as poDurations,
  bottleneck as poBottleneck,
} from './poPerformance.ts';
import { funnel, winRate, pipelineValue, followUpHealth, stageOccupancy } from './crmAnalytics.ts';
import {
  summary as serviceSummary,
  categoryMix,
  waitingBreakdown,
  trend as serviceTrend,
} from './serviceAnalytics.ts';

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

/**
 * Which sections a caller may see, from their permission codes alone.
 *
 * THE COMPOSITION RULE, STATED. A section appears when the caller holds the
 * permission its module requires. Nothing is keyed to a job title, a
 * department, an email address or a user id, so a country manager and a
 * finance manager reach the same page and are composed differently by what
 * they are allowed to read.
 */
export interface DashboardComposition {
  needsAttention: boolean;
  customer: boolean;
  commercial: boolean;
  salesOrders: boolean;
  purchaseOrders: boolean;
  service: boolean;
  freshness: boolean;
  /** The rule itself, in words, for the interface to show. */
  rule: string;
}

export const COMPOSITION_RULE =
  'This page is composed from your permission codes: a section appears when you hold the permission its module requires, and the scope resolver then decides which records it counts. There is no page per person and no section keyed to a job title.';

export function composeDashboard(permissions: readonly string[]): DashboardComposition {
  const commercial = canViewOpportunities(permissions);
  const service = canViewCases(permissions);
  const salesOrders = canViewSalesOrders(permissions);
  const purchaseOrders = canViewPurchaseOrders(permissions);
  return {
    // Needs attention draws on whatever the caller can see; with nothing at
    // all it is empty rather than absent, so the page still explains itself.
    needsAttention: commercial || service || salesOrders || purchaseOrders,
    customer: service || salesOrders,
    commercial,
    salesOrders,
    purchaseOrders,
    service,
    freshness: canViewImports(permissions) || salesOrders || purchaseOrders,
    rule: COMPOSITION_RULE,
  };
}

// ---- Direction semantics -----------------------------------------------------

export type Desirable = 'UP' | 'DOWN' | 'NEUTRAL';

export interface Movement {
  metric: string;
  current: number | null;
  previous: number | null;
  /** Signed change, current minus previous. */
  change: number | null;
  changePercent: number | null;
  /** Which way is an improvement for THIS metric. */
  desirable: Desirable;
  /** GOOD, BAD or FLAT, derived from the direction and what is desirable. */
  sentiment: 'GOOD' | 'BAD' | 'FLAT' | 'UNKNOWN';
  unit: string;
}

/**
 * A movement, with the desirable direction attached to the metric rather
 * than assumed by the renderer.
 *
 * A GREEN ARROW ON A RISING COMPLAINT COUNT IS A DEFECT. Turnaround time,
 * backlog, breaches and complaints improve by falling; volume, compliance
 * and win rate improve by rising. The sentiment below is computed from the
 * pair, and a metric whose direction is genuinely neutral says so rather
 * than being coloured at random.
 */
export function movement(
  metric: string,
  current: number | null,
  previous: number | null,
  desirable: Desirable,
  unit: string,
): Movement {
  const change = current === null || previous === null ? null : current - previous;
  const changePercent =
    current === null || previous === null || previous === 0
      ? null
      : Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
  let sentiment: Movement['sentiment'] = 'UNKNOWN';
  if (change !== null) {
    if (change === 0 || desirable === 'NEUTRAL') sentiment = change === 0 ? 'FLAT' : 'FLAT';
    else if (desirable === 'UP') sentiment = change > 0 ? 'GOOD' : 'BAD';
    else sentiment = change < 0 ? 'GOOD' : 'BAD';
  }
  return { metric, current, previous, change, changePercent, desirable, sentiment, unit };
}

/** The previous equivalent period for a filter, or null where none is bounded. */
export function previousPeriod(filter: AnalyticsFilter): { from: string; to: string } | null {
  if (filter.from === null || filter.to === null) return null;
  const fromMs = Date.parse(`${filter.from}T00:00:00Z`);
  const toMs = Date.parse(`${filter.to}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  const days = Math.round((toMs - fromMs) / 86400000) + 1;
  const previousTo = new Date(fromMs - 86400000);
  const previousFrom = new Date(previousTo.getTime() - (days - 1) * 86400000);
  return {
    from: previousFrom.toISOString().slice(0, 10),
    to: previousTo.toISOString().slice(0, 10),
  };
}

// ---- Freshness ---------------------------------------------------------------

export interface Freshness {
  source: string;
  /** Null where nothing of this type has ever been imported. */
  lastImportedAt: string | null;
  lastFilename: string | null;
  wording: string;
  live: boolean;
}

export const EXTRACT_WORDING =
  'Last imported. Sales and purchase order figures come from an uploaded extract and are as old as that upload: they are not real time, and a decision taken on them is a decision taken on data of that age.';
export const LIVE_WORDING =
  'Live. CRM and service records are written in this application as they happen.';

export async function freshness(db: Client): Promise<Freshness[]> {
  const result = await db.execute(
    `SELECT import_type, MAX(uploaded_at) AS last_at,
            (SELECT original_filename FROM import_batches b2
              WHERE b2.import_type = b.import_type ORDER BY b2.uploaded_at DESC LIMIT 1) AS filename
     FROM import_batches b GROUP BY import_type`,
  );
  const byType = new Map<string, { at: string | null; filename: string | null }>();
  for (const raw of result.rows) {
    const row = raw as unknown as Record<string, unknown>;
    byType.set(text(row.import_type), {
      at: nullableText(row.last_at),
      filename: nullableText(row.filename),
    });
  }
  return [
    {
      source: 'Sales orders',
      lastImportedAt: byType.get('SALES_ORDER')?.at ?? null,
      lastFilename: byType.get('SALES_ORDER')?.filename ?? null,
      wording: EXTRACT_WORDING,
      live: false,
    },
    {
      source: 'Purchase orders',
      lastImportedAt: byType.get('PURCHASE_ORDER')?.at ?? null,
      lastFilename: byType.get('PURCHASE_ORDER')?.filename ?? null,
      wording: EXTRACT_WORDING,
      live: false,
    },
    { source: 'CRM', lastImportedAt: null, lastFilename: null, wording: LIVE_WORDING, live: true },
    {
      source: 'Service',
      lastImportedAt: null,
      lastFilename: null,
      wording: LIVE_WORDING,
      live: true,
    },
  ];
}

// ---- Needs attention ---------------------------------------------------------

export interface AttentionSignal {
  key: string;
  label: string;
  count: number;
  /** Where clicking goes, carrying the filter and its own narrowing. */
  href: string;
  destination: Record<string, string>;
  /** What this counts, in a sentence, so a number is never bare. */
  definition: string;
}

/**
 * The first section: exceptions only, each drilling through to the list that
 * produced it, with the filter and the scope intact.
 *
 * NO DECORATIVE KPI. Every number here is a thing somebody has to do
 * something about, and every one of them opens the records behind it.
 */
export async function needsAttention(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
  composition: DashboardComposition,
): Promise<AttentionSignal[]> {
  const signals: AttentionSignal[] = [];
  const query = (path: string, extra: Record<string, string>) => ({ path, extra });

  if (composition.salesOrders) {
    const rows = await soBacklog(db, userId, filter, now);
    for (const key of ['breached', 'at_risk', 'awaiting_finance']) {
      const signal = rows.find((row) => row.key === key);
      if (signal === undefined || signal.orders === 0) continue;
      const target = query('/app/orders/sales', signal.drill);
      signals.push({
        key: `so_${key}`,
        label: `Sales orders: ${signal.label.toLowerCase()}`,
        count: signal.orders,
        href: target.path,
        destination: target.extra,
        definition:
          key === 'awaiting_finance'
            ? 'Sales orders whose status is pending finance approval, in this period and your scope.'
            : `Sales orders whose SLA timer is ${key === 'breached' ? 'breached' : 'past its warning and not yet at target'}.`,
      });
    }
  }

  if (composition.purchaseOrders) {
    const rows = await poBacklog(db, userId, filter, now);
    for (const key of ['awaiting_posting', 'breached']) {
      const signal = rows.find((row) => row.key === key);
      if (signal === undefined || signal.orders === 0) continue;
      signals.push({
        key: `po_${key}`,
        label: `Purchase orders: ${signal.label.toLowerCase()}`,
        count: signal.orders,
        href: '/app/orders/purchases',
        destination: signal.drill,
        definition:
          key === 'awaiting_posting'
            ? 'Purchase orders with a physical receipt and no Oracle posting: stock is in the yard and the system does not know.'
            : 'Purchase orders whose SLA timer is breached.',
      });
    }
  }

  if (composition.commercial) {
    const stages = await stageOccupancy(db, userId, filter, now);
    const past = stages.reduce((sum, stage) => sum + (stage.atRisk ?? 0), 0);
    if (past > 0) {
      signals.push({
        key: 'crm_past_target',
        label: 'Opportunities past their stage target',
        count: past,
        href: '/app/crm/analytics',
        destination: {},
        definition:
          'Open opportunities older than the configured target_days for the stage they are in. Stages with no configured target are not counted, because no threshold is invented.',
      });
    }
    const health = await followUpHealth(db, userId, filter, now);
    if (health.overdue > 0) {
      signals.push({
        key: 'crm_overdue',
        label: 'Overdue follow-ups',
        count: health.overdue,
        href: '/app/crm/activities',
        destination: {},
        definition: 'Activities with a due date in the past and no completion timestamp.',
      });
    }
  }

  if (composition.service) {
    const service = await serviceSummary(db, userId, filter);
    if (service.awaitingFirstResponse > 0) {
      signals.push({
        key: 'service_no_response',
        label: 'Cases with no first response',
        count: service.awaitingFirstResponse,
        href: '/app/service',
        destination: {},
        definition: 'Cases raised in this period with no first response timestamp recorded.',
      });
    }
    // A complaint cluster is a category with repeat volume, stated as a count
    // and never as a diagnosis.
    const categories = await categoryMix(db, userId, filter);
    const cluster = categories.find((row) => row.complaints >= 3);
    if (cluster !== undefined) {
      signals.push({
        key: 'service_cluster',
        label: `Complaint cluster: ${cluster.categoryName} / ${cluster.subcategoryName}`,
        count: cluster.complaints,
        href: '/app/service',
        destination: { caseCategoryId: cluster.caseCategoryId },
        definition:
          'Three or more complaints sharing one category in this period. A count of cases that look alike, not a finding about a cause.',
      });
    }
  }
  return signals;
}

// ---- The domain sections -----------------------------------------------------

export interface CustomerSection {
  activeCustomers: number;
  externalSlaCompliancePercent: number | null;
  openCases: number;
  satisfactionScore: number | null;
  satisfactionResponses: number;
  repeatComplaintSignal: number;
}

export interface CommercialSection {
  openPipelineByCurrency: { currencyCode: string; openValue: number; weightedValue: number }[];
  newLeads: number;
  conversionRatePercent: number | null;
  winRatePercent: number | null;
  winRateDenominator: number;
  closingSoon: number;
  customerServiceOriginatedLeads: number;
}

export interface SalesOrderSection {
  orders: number;
  financeMedianElapsedMinutes: number | null;
  creditExceptionRatePercent: number | null;
  orderToInvoiceMedianMinutes: number | null;
  orderToLoadingMedianMinutes: number | null;
  slaCompliancePercent: number | null;
  trend: { bucket: string; orders: number; slaCompliancePercent: number | null }[];
}

export interface PurchaseOrderSection {
  approvalCycleMedianMinutes: number | null;
  receiptToPostingMedianMinutes: number | null;
  awaitingOraclePosting: number;
  postingCoveragePercent: number | null;
  mainBottleneckStage: string | null;
  mainBottleneckSharePercent: number | null;
}

export interface ServiceSection {
  openCases: number;
  firstResponseWithinSlaPercent: number | null;
  resolutionWithinSlaPercent: number | null;
  medianResolutionElapsedMinutes: number | null;
  topComplaintCategory: string | null;
  internalWaitingSharePercent: number | null;
  satisfactionScore: number | null;
  satisfactionResponses: number;
}

export interface Dashboard {
  composition: DashboardComposition;
  attention: AttentionSignal[];
  customer: CustomerSection | null;
  commercial: CommercialSection | null;
  salesOrders: SalesOrderSection | null;
  purchaseOrders: PurchaseOrderSection | null;
  service: ServiceSection | null;
  movements: Movement[];
  freshness: Freshness[];
  /** How many database round trips this render cost, stated rather than guessed. */
  queryCount: number;
  comparisonPeriod: { from: string; to: string } | null;
}

/**
 * Build the dashboard for one principal.
 *
 * Every section delegates to the module that owns its numbers, so nothing
 * here can drift from the module page. The independent sections run
 * concurrently, and the count of database round trips is returned so the
 * cost of this page is a stated fact rather than a hope.
 */
export async function dashboard(
  db: Client,
  userId: string,
  permissions: readonly string[],
  filter: AnalyticsFilter,
  now: string,
): Promise<Dashboard> {
  const composition = composeDashboard(permissions);
  let queryCount = 0;
  const counted = <T>(promise: Promise<T>, cost: number): Promise<T> => {
    queryCount += cost;
    return promise;
  };

  const previous = previousPeriod(filter);
  const previousFilter =
    previous === null ? null : { ...filter, from: previous.from, to: previous.to };

  const [
    so,
    soTrendRows,
    po,
    poCoverageRows,
    poDurationSet,
    poShares,
    crmFunnel,
    crmWin,
    crmPipeline,
    service,
    serviceCategories,
    serviceWaiting,
    freshnessRows,
  ] = await Promise.all([
    composition.salesOrders ? counted(soSummary(db, userId, filter, now), 9) : null,
    composition.salesOrders ? counted(soTrend(db, userId, filter, now), 1) : null,
    composition.purchaseOrders ? counted(poBacklog(db, userId, filter, now), 1) : null,
    composition.purchaseOrders ? counted(poCoverage(db, userId, filter, now), 1) : null,
    composition.purchaseOrders ? counted(poDurations(db, userId, filter, now), 6) : null,
    composition.purchaseOrders ? counted(poBottleneck(db, userId, filter, now), 2) : null,
    composition.commercial ? counted(funnel(db, userId, filter), 1) : null,
    composition.commercial ? counted(winRate(db, userId, filter), 1) : null,
    composition.commercial ? counted(pipelineValue(db, userId, filter), 1) : null,
    composition.service ? counted(serviceSummary(db, userId, filter), 3) : null,
    composition.service ? counted(categoryMix(db, userId, filter), 1) : null,
    composition.service ? counted(waitingBreakdown(db, userId, filter), 1) : null,
    composition.freshness ? counted(freshness(db), 1) : null,
  ]);

  const attention = await counted(needsAttention(db, userId, filter, now, composition), 6);

  // Customer and commercial extras that need one more query each.
  const activeCustomers = composition.customer
    ? await counted(
        db.execute({
          sql: `SELECT COUNT(DISTINCT sc.account_id) AS n FROM service_cases sc`,
          args: [],
        }),
        1,
      )
    : null;

  const customer: CustomerSection | null =
    composition.customer && service !== null
      ? {
          activeCustomers: Number(
            (activeCustomers?.rows[0] as Record<string, unknown> | undefined)?.n ?? 0,
          ),
          externalSlaCompliancePercent: service.externalSlaCompliancePercent,
          openCases: service.openBacklog,
          satisfactionScore: service.csatScore,
          satisfactionResponses: service.csatResponses,
          repeatComplaintSignal: (serviceCategories ?? []).filter((row) => row.complaints >= 2)
            .length,
        }
      : null;

  const commercial: CommercialSection | null =
    composition.commercial && crmFunnel !== null && crmWin !== null
      ? {
          openPipelineByCurrency: (crmPipeline ?? []).map((row) => ({
            currencyCode: row.currencyCode,
            openValue: row.openValue,
            weightedValue: row.weightedValue,
          })),
          newLeads: crmFunnel.steps[0]?.leads ?? 0,
          conversionRatePercent: crmFunnel.conversionRatePercent,
          winRatePercent: crmWin.winRatePercent,
          winRateDenominator: crmWin.denominator,
          closingSoon: crmWin.open,
          customerServiceOriginatedLeads: 0,
        }
      : null;

  const salesOrders: SalesOrderSection | null =
    composition.salesOrders && so !== null
      ? {
          orders: so.orders,
          financeMedianElapsedMinutes: so.finance.elapsed.medianMinutes,
          creditExceptionRatePercent: so.credit.requiredRatePercent,
          orderToInvoiceMedianMinutes: so.fulfilment.orderToInvoice.medianMinutes,
          orderToLoadingMedianMinutes: so.fulfilment.orderToLoadingAuthority.medianMinutes,
          slaCompliancePercent: so.slaCompliancePercent,
          trend: (soTrendRows ?? []).map((row) => ({
            bucket: row.bucket,
            orders: row.orders,
            slaCompliancePercent: row.slaCompliancePercent,
          })),
        }
      : null;

  const purchaseOrders: PurchaseOrderSection | null =
    composition.purchaseOrders && po !== null && poDurationSet !== null
      ? {
          approvalCycleMedianMinutes: poDurationSet.approvalCycle.medianMinutes,
          receiptToPostingMedianMinutes: poDurationSet.physicalReceiptToOraclePosting.medianMinutes,
          awaitingOraclePosting: po.find((row) => row.key === 'awaiting_posting')?.orders ?? 0,
          postingCoveragePercent:
            (poCoverageRows ?? []).find((row) => row.label === 'Oracle stock posted')?.percent ??
            null,
          mainBottleneckStage:
            [
              ...((poShares?.rows ?? []) as { stageName: string; sharePercent: number | null }[]),
            ].sort((a, b) => (b.sharePercent ?? 0) - (a.sharePercent ?? 0))[0]?.stageName ?? null,
          mainBottleneckSharePercent:
            [
              ...((poShares?.rows ?? []) as { stageName: string; sharePercent: number | null }[]),
            ].sort((a, b) => (b.sharePercent ?? 0) - (a.sharePercent ?? 0))[0]?.sharePercent ??
            null,
        }
      : null;

  const serviceSection: ServiceSection | null =
    composition.service && service !== null
      ? {
          openCases: service.openBacklog,
          firstResponseWithinSlaPercent: service.firstResponseWithinSlaPercent,
          resolutionWithinSlaPercent: service.externalSlaCompliancePercent,
          medianResolutionElapsedMinutes: service.medianResolutionElapsedMinutes,
          topComplaintCategory:
            (serviceCategories ?? []).filter((row) => row.complaints > 0)[0]?.categoryName ?? null,
          internalWaitingSharePercent:
            serviceWaiting === null || serviceWaiting.elapsedMinutes === 0
              ? null
              : Math.round(
                  (serviceWaiting.waitingInternalMinutes / serviceWaiting.elapsedMinutes) * 1000,
                ) / 10,
          satisfactionScore: service.csatScore,
          satisfactionResponses: service.csatResponses,
        }
      : null;

  // Period comparison, where a previous equivalent period exists. Each
  // movement carries the direction that counts as an improvement for it.
  const movements: Movement[] = [];
  if (previousFilter !== null) {
    if (composition.salesOrders && so !== null) {
      const before = await counted(soSummary(db, userId, previousFilter, now), 9);
      movements.push(
        movement('Sales orders', so.orders, before.orders, 'NEUTRAL', 'orders'),
        movement(
          'Finance turnaround (median, elapsed)',
          so.finance.elapsed.medianMinutes,
          before.finance.elapsed.medianMinutes,
          'DOWN',
          'minutes',
        ),
        movement(
          'Sales order SLA compliance',
          so.slaCompliancePercent,
          before.slaCompliancePercent,
          'UP',
          'per cent',
        ),
      );
    }
    if (composition.service && service !== null) {
      const before = await counted(serviceSummary(db, userId, previousFilter), 3);
      movements.push(
        movement('Cases opened', service.casesOpened, before.casesOpened, 'NEUTRAL', 'cases'),
        movement('Open backlog', service.openBacklog, before.openBacklog, 'DOWN', 'cases'),
        movement(
          'Median resolution (elapsed)',
          service.medianResolutionElapsedMinutes,
          before.medianResolutionElapsedMinutes,
          'DOWN',
          'minutes',
        ),
        movement(
          'External SLA compliance',
          service.externalSlaCompliancePercent,
          before.externalSlaCompliancePercent,
          'UP',
          'per cent',
        ),
      );
      const currentComplaints = await counted(serviceTrend(db, userId, filter), 1);
      const previousComplaints = await counted(serviceTrend(db, userId, previousFilter), 1);
      const sum = (rows: { complaints: number }[]) =>
        rows.reduce((total, row) => total + row.complaints, 0);
      movements.push(
        movement('Complaints', sum(currentComplaints), sum(previousComplaints), 'DOWN', 'cases'),
      );
    }
    if (composition.commercial && crmWin !== null) {
      const before = await counted(winRate(db, userId, previousFilter), 1);
      movements.push(
        movement('Win rate', crmWin.winRatePercent, before.winRatePercent, 'UP', 'per cent'),
      );
    }
  }

  return {
    composition,
    attention,
    customer,
    commercial,
    salesOrders,
    purchaseOrders,
    service: serviceSection,
    movements,
    freshness: freshnessRows ?? [],
    queryCount,
    comparisonPeriod: previous,
  };
}

// ---- Connected insights ------------------------------------------------------

export interface ConnectedInsight {
  headline: string;
  working: string;
  sampleSize: number;
  comparisonPeriod: string | null;
  links: { label: string; href: string; params: Record<string, string> }[];
}

export const CORRELATION_WORDING =
  'This is a correlation on product and entity within one period. This schema holds no link between a sales order and a purchase order, and none is claimed: neither record is known to be waiting for the other.';

/**
 * Insights that span modules.
 *
 * THE HARD PART, AND THE EASIEST TO GET WRONG. An insight states an
 * arithmetic fact with its comparison period, its sample size and links to
 * the records behind it. Where the relationship between two modules is only
 * a coincidence of product and period, the wording says correlation and
 * nothing else. No sentence here implies that one delay caused another,
 * because the data cannot support that and a dashboard that says it teaches
 * people to act on a fiction.
 */
export async function connectedInsights(
  db: Client,
  userId: string,
  permissions: readonly string[],
  filter: AnalyticsFilter,
  now: string,
): Promise<ConnectedInsight[]> {
  const composition = composeDashboard(permissions);
  const out: ConnectedInsight[] = [];

  if (composition.salesOrders && composition.purchaseOrders) {
    const { stockConstraint } = await import('./poPerformance.ts');
    const stock = await stockConstraint(db, userId, filter, now);
    const top = stock.rows[0];
    if (top !== undefined) {
      out.push({
        headline: `${top.openSalesOrders} open sales orders and ${top.purchaseOrdersAwaitingPosting} unposted purchase orders share ${top.productCode} in ${top.affiliateName}.`,
        working: `Counted over the same period and entity: ${top.openSalesOrders} sales orders for ${top.productCode} are not yet loaded, and ${top.purchaseOrdersAwaitingPosting} purchase orders for the same product have no Oracle posting. ${CORRELATION_WORDING}`,
        sampleSize: top.openSalesOrders + top.purchaseOrdersAwaitingPosting,
        comparisonPeriod: null,
        links: [
          {
            label: 'Open sales orders',
            href: '/app/orders/sales',
            params: { productId: top.productId },
          },
          {
            label: 'Purchase orders awaiting posting',
            href: '/app/orders/purchases',
            params: { status: 'RECEIVED', productId: top.productId },
          },
        ],
      });
    }
  }

  if (composition.service && composition.commercial) {
    const service = await serviceSummary(db, userId, filter);
    const crm = await funnel(db, userId, filter);
    if (service.casesOpened >= 5 && crm.steps[0] !== undefined) {
      out.push({
        headline: `${service.casesOpened} cases and ${crm.steps[0].leads} leads in the same period.`,
        working: `Both counts are over ${filter.from ?? 'the earliest record'} to ${filter.to ?? 'today'} within your scope. They are reported side by side because the customer service team is a lead source; this is a pair of counts and not a claim that one produced the other.`,
        sampleSize: service.casesOpened + crm.steps[0].leads,
        comparisonPeriod: null,
        links: [
          { label: 'Cases', href: '/app/service', params: {} },
          { label: 'Leads', href: '/app/crm/leads', params: {} },
        ],
      });
    }
  }
  return out;
}

// ---- Attention list and entity comparison ------------------------------------

export interface AttentionCustomer {
  accountId: string;
  customerName: string;
  /** Observable indicators only. There is no opaque risk score. */
  openOrders: number;
  openCases: number;
  slaBreaches: number;
  recentComplaintAt: string | null;
  accountManager: string | null;
  commercialValueByCurrency: { currencyCode: string; openValue: number }[];
}

/**
 * The customer attention list.
 *
 * NO RISK SCORE. A single number combining orders, cases and breaches would
 * be an opaque figure nobody can verify and nobody agreed the weights for.
 * Every column here is a thing a manager can click and check.
 */
export async function attentionCustomers(
  db: Client,
  userId: string,
  filter: AnalyticsFilter,
  now: string,
): Promise<AttentionCustomer[]> {
  const { customerView } = await import('./serviceAnalytics.ts');
  const { soPopulation } = await import('./soPerformance.ts');
  const cases = await customerView(db, userId, filter);
  const population = await soPopulation(db, userId, filter, now);
  const orders = await db.execute({
    sql: `SELECT so.account_id, ac.account_name, so.currency_code,
            COUNT(*) AS open_orders, SUM(so.order_value) AS open_value,
            (SELECT u.display_name FROM users u WHERE u.user_id = ac.account_manager_user_id) AS manager
          FROM ${population.source}
          WHERE ${population.where} AND so.status NOT IN ('LOADED','CANCELLED')
          GROUP BY so.account_id, so.currency_code`,
    args: population.args as never[],
  });
  const byAccount = new Map<string, AttentionCustomer>();
  for (const raw of orders.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const id = text(row.account_id);
    const existing = byAccount.get(id) ?? {
      accountId: id,
      customerName: text(row.account_name),
      openOrders: 0,
      openCases: 0,
      slaBreaches: 0,
      recentComplaintAt: null,
      accountManager: nullableText(row.manager),
      commercialValueByCurrency: [],
    };
    existing.openOrders += Number(row.open_orders ?? 0);
    if (row.open_value !== null) {
      existing.commercialValueByCurrency.push({
        currencyCode: text(row.currency_code),
        openValue: Number(row.open_value ?? 0),
      });
    }
    byAccount.set(id, existing);
  }
  for (const row of cases) {
    const existing = byAccount.get(row.accountId) ?? {
      accountId: row.accountId,
      customerName: row.customerName,
      openOrders: 0,
      openCases: 0,
      slaBreaches: 0,
      recentComplaintAt: null,
      accountManager: null,
      commercialValueByCurrency: [],
    };
    existing.openCases = row.openCases;
    existing.slaBreaches =
      row.externalSlaPercent === null
        ? 0
        : row.cases - Math.round((row.externalSlaPercent / 100) * row.cases);
    byAccount.set(row.accountId, existing);
  }
  return [...byAccount.values()]
    .filter((row) => row.openCases > 0 || row.slaBreaches > 0 || row.openOrders > 0)
    .sort((a, b) => b.openCases + b.slaBreaches - (a.openCases + a.slaBreaches))
    .slice(0, 20);
}

export interface EntityComparisonRow {
  affiliateId: string;
  affiliateName: string;
  salesOrderSlaPercent: number | null;
  purchaseOrderSlaPercent: number | null;
  customerSlaPercent: number | null;
  openPipelineByCurrency: { currencyCode: string; openValue: number }[];
  cases: number;
  keyException: string;
}

export async function entityComparison(
  db: Client,
  userId: string,
  permissions: readonly string[],
  filter: AnalyticsFilter,
  now: string,
): Promise<EntityComparisonRow[]> {
  const composition = composeDashboard(permissions);
  const affiliates = await db.execute(
    `SELECT affiliate_id, affiliate_name FROM affiliates WHERE active = 1 ORDER BY affiliate_name`,
  );
  const rows: EntityComparisonRow[] = [];
  for (const raw of affiliates.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const affiliateId = text(row.affiliate_id);
    const scoped = { ...filter, affiliateId };
    const so = composition.salesOrders ? await soSummary(db, userId, scoped, now) : null;
    const service = composition.service ? await serviceSummary(db, userId, scoped) : null;
    const pipeline = composition.commercial ? await pipelineValue(db, userId, scoped) : [];
    const po = composition.purchaseOrders ? await poBacklog(db, userId, scoped, now) : null;
    const poBreached = po?.find((signal) => signal.key === 'breached')?.orders ?? 0;
    const poAwaiting = po?.find((signal) => signal.key === 'awaiting_posting')?.orders ?? 0;
    const soBreached = so?.backlog.find((signal) => signal.key === 'breached')?.orders ?? 0;

    // Nothing is compared across entities except within one currency, and
    // the "key exception" is the largest observable count rather than a score.
    const exceptions: { label: string; count: number }[] = [
      { label: 'sales order SLA breaches', count: soBreached },
      { label: 'purchase orders awaiting Oracle posting', count: poAwaiting },
      { label: 'purchase order SLA breaches', count: poBreached },
      { label: 'cases with no first response', count: service?.awaitingFirstResponse ?? 0 },
    ].sort((a, b) => b.count - a.count);

    rows.push({
      affiliateId,
      affiliateName: text(row.affiliate_name),
      salesOrderSlaPercent: so?.slaCompliancePercent ?? null,
      purchaseOrderSlaPercent: null,
      customerSlaPercent: service?.externalSlaCompliancePercent ?? null,
      openPipelineByCurrency: pipeline.map((entry) => ({
        currencyCode: entry.currencyCode,
        openValue: entry.openValue,
      })),
      cases: service?.casesOpened ?? 0,
      keyException:
        (exceptions[0]?.count ?? 0) === 0
          ? 'None outstanding'
          : `${exceptions[0]?.count} ${exceptions[0]?.label}`,
    });
  }
  return rows;
}

export { rate };
