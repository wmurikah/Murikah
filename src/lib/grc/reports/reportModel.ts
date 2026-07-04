/**
 * The report core: the pure filters and computations behind the four board
 * reports, ported from the source getComprehensiveReportData aggregation. It
 * parses the filters (with the last-six-months default and the UNIT_MANAGER
 * scoping), normalises risk ratings, and turns the scoped dataset into a generic
 * ReportDocument. The same document is rendered to the HTML preview and to the
 * Word export, so the figures and the structure are computed once and never
 * diverge.
 *
 * Imports are types only, so node can strip types and unit-test this directly.
 * The board reporting logic lives here as one cohesive, dependency-free unit.
 */
import type {
  ActionPlan,
  Cell,
  Kpi,
  Observation,
  ReportBlock,
  ReportDataset,
  ReportDocument,
  ReportFilters,
  ReportHeader,
  ReportType,
  RiskBucket,
  Tone,
} from './reportTypes';

const DAY_MS = 86400000;
const AT_RISK_DAYS = 14;

// ---- Constants -------------------------------------------------------------

export const REPORT_TYPES: { value: ReportType; label: string }[] = [
  { value: 'executive', label: 'Executive Summary' },
  { value: 'observations', label: 'Detailed Observations' },
  { value: 'tracker', label: 'Action Plan Tracker' },
  { value: 'overdue', label: 'Overdue and At-Risk' },
];

export const RISK_BUCKETS: RiskBucket[] = ['EXTREME', 'HIGH', 'MEDIUM', 'LOW'];

export const RISK_LABELS: Record<RiskBucket, string> = {
  EXTREME: 'Extreme',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

/** The work-paper statuses the report filters by, with their labels. */
export const STATUS_OPTIONS: { value: string; label: string; auditeeOnly?: boolean }[] = [
  { value: 'APPROVED', label: 'Approved' },
  { value: 'SENT_TO_AUDITEE', label: 'Sent to Auditee' },
  { value: 'SUBMITTED', label: 'Submitted', auditeeOnly: true },
  { value: 'DRAFT', label: 'Draft', auditeeOnly: true },
];

/** Statuses a UNIT_MANAGER never sees in the report (drafts and submissions). */
export const UNIT_MANAGER_HIDDEN_STATUSES = ['DRAFT', 'SUBMITTED'];

/**
 * Action-plan statuses that are not counted as overdue: the plan is implemented
 * or otherwise settled. The source treats Implemented, Verified, Not Implemented,
 * Closed and Rejected as not-overdue; PENDING_VERIFICATION is the
 * implemented-and-awaiting-verification state in this build, settled from the
 * owner's side, so it is included here too.
 */
export const NOT_OVERDUE_STATUSES = [
  'IMPLEMENTED',
  'PENDING_VERIFICATION',
  'VERIFIED',
  'NOT_IMPLEMENTED',
  'CLOSED',
  'REJECTED',
];

/** Statuses that count towards the implementation rate. */
export const IMPLEMENTED_STATUSES = ['IMPLEMENTED', 'PENDING_VERIFICATION', 'VERIFIED', 'CLOSED'];

export function reportTypeLabel(type: ReportType): string {
  return REPORT_TYPES.find((t) => t.value === type)?.label ?? 'Report';
}

/** The scoping applies to a UNIT_MANAGER who is not a platform owner. */
export function isUnitManagerScope(roleCode: string, isPlatformOwner: boolean): boolean {
  return roleCode === 'UNIT_MANAGER' && !isPlatformOwner;
}

/**
 * Normalise a stored risk rating to one of the four report buckets. The board
 * report groups by Extreme, High, Medium and Low; the work-paper data may store
 * the top band as CRITICAL (see grc/docs/schema-assumptions.md), so CRITICAL and
 * EXTREME both fall into the Extreme bucket. Anything unrecognised returns null.
 */
export function normaliseRisk(raw: string | null | undefined): RiskBucket | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase();
  if (v === 'EXTREME' || v === 'CRITICAL' || v === 'VERY HIGH') return 'EXTREME';
  if (v === 'HIGH') return 'HIGH';
  if (v === 'MEDIUM' || v === 'MODERATE') return 'MEDIUM';
  if (v === 'LOW' || v === 'MINOR') return 'LOW';
  return null;
}

// ---- Filters ---------------------------------------------------------------

/** Format a date as YYYY-MM-DD in UTC. */
export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The default date range: the last six months up to today. */
export function defaultDateRange(now: Date): { from: string; to: string } {
  const to = ymd(now);
  const from = ymd(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, now.getUTCDate())),
  );
  return { from, to };
}

export interface FilterScope {
  roleCode: string;
  isPlatformOwner: boolean;
  /** The UNIT_MANAGER's own affiliate, forced into the filter when present. */
  forcedAffiliateCode?: string | null;
}

/**
 * Parse the report filters from the query string, applying the defaults and the
 * UNIT_MANAGER scoping. Without the `applied` marker (a fresh page load) every
 * risk bucket and status is on and the date range is the last six months.
 */
export function parseReportFilters(
  params: URLSearchParams,
  scope: FilterScope,
  now: Date,
): ReportFilters {
  const applied = params.get('applied') === '1';
  const unitScope = isUnitManagerScope(scope.roleCode, scope.isPlatformOwner);

  const yearRaw = params.get('year');
  const year = yearRaw && /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;

  const range = defaultDateRange(now);
  const dateFrom = params.get('date_from') || range.from;
  const dateTo = params.get('date_to') || range.to;

  let risks = params
    .getAll('risk')
    .filter((r): r is RiskBucket => RISK_BUCKETS.includes(r as RiskBucket));
  if (!applied || risks.length === 0) risks = [...RISK_BUCKETS];

  const allowedStatuses = STATUS_OPTIONS.filter(
    (o) => !(unitScope && UNIT_MANAGER_HIDDEN_STATUSES.includes(o.value)),
  ).map((o) => o.value);
  let statuses = params.getAll('status').filter((s) => allowedStatuses.includes(s));
  if (!applied || statuses.length === 0) statuses = [...allowedStatuses];

  const affiliateCode = unitScope
    ? (scope.forcedAffiliateCode ?? null)
    : params.get('affiliate') || null;

  const typeRaw = params.get('type');
  const reportType: ReportType =
    REPORT_TYPES.find((t) => t.value === typeRaw)?.value ?? 'executive';

  return {
    year,
    dateFrom,
    dateTo,
    affiliateCode,
    auditAreaId: params.get('audit_area') || null,
    risks,
    statuses,
    overdueOnly: params.get('overdue_only') === '1',
    reportType,
  };
}

export interface SummaryLabels {
  affiliateName?: string | null;
  auditAreaName?: string | null;
}

/** A one-line human summary of the active filters, for the report header. */
export function filterSummary(filters: ReportFilters, labels: SummaryLabels = {}): string {
  const parts: string[] = [];
  parts.push(`Year: ${filters.year ?? 'All years'}`);
  parts.push(`${filters.dateFrom} to ${filters.dateTo}`);
  parts.push(
    `Affiliate: ${filters.affiliateCode ? (labels.affiliateName ?? filters.affiliateCode) : 'All'}`,
  );
  parts.push(
    `Audit area: ${filters.auditAreaId ? (labels.auditAreaName ?? filters.auditAreaId) : 'All'}`,
  );
  parts.push(
    `Risk: ${filters.risks.length === RISK_BUCKETS.length ? 'All' : filters.risks.map((r) => RISK_LABELS[r]).join(', ')}`,
  );
  parts.push(
    `Status: ${
      filters.statuses.length === 0
        ? 'None'
        : filters.statuses
            .map((s) => STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s)
            .join(', ')
    }`,
  );
  if (filters.overdueOnly) parts.push('Overdue items only');
  return parts.join(' · ');
}

// ---- Overdue and rate helpers ----------------------------------------------

function parseMs(d: string | null): number | null {
  if (!d) return null;
  const ms = Date.parse(d);
  return Number.isNaN(ms) ? null : ms;
}

function daysBetween(aMs: number, bMs: number): number {
  return Math.floor((bMs - aMs) / DAY_MS);
}

/** An action plan is overdue when its due date has passed and it is not settled. */
export function isPlanOverdue(ap: Pick<ActionPlan, 'dueDate' | 'status'>, now: Date): boolean {
  if (NOT_OVERDUE_STATUSES.includes(ap.status)) return false;
  const due = parseMs(ap.dueDate);
  if (due == null) return false;
  return due < now.getTime();
}

/** Days a plan is overdue (0 when not overdue). */
export function daysOverdue(ap: Pick<ActionPlan, 'dueDate' | 'status'>, now: Date): number {
  if (!isPlanOverdue(ap, now)) return 0;
  const due = parseMs(ap.dueDate);
  return due == null ? 0 : Math.max(0, daysBetween(due, now.getTime()));
}

/** Days until a plan is due (negative when past due; null with no date). */
export function daysUntilDue(ap: Pick<ActionPlan, 'dueDate'>, now: Date): number | null {
  const due = parseMs(ap.dueDate);
  if (due == null) return null;
  return daysBetween(now.getTime(), due);
}

function isImplemented(ap: Pick<ActionPlan, 'status'>): boolean {
  return IMPLEMENTED_STATUSES.includes(ap.status);
}

/** Round a ratio to a whole percent (0 when the denominator is 0). */
export function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

/** The implementation-rate colour: green at least 70, amber at least 40, else red. */
export function implementationTone(rate: number): Tone {
  if (rate >= 70) return 'good';
  if (rate >= 40) return 'warn';
  return 'bad';
}

function riskTone(bucket: RiskBucket): Tone {
  return `risk-${bucket.toLowerCase()}` as Tone;
}

/** Humanise a status code (IN_PROGRESS -> In progress), unless a label is given. */
export function humaniseStatus(code: string, labels?: Record<string, string>): string {
  if (labels && labels[code]) return labels[code];
  const spaced = code.replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function riskRank(bucket: RiskBucket | null): number {
  switch (bucket) {
    case 'EXTREME':
      return 0;
    case 'HIGH':
      return 1;
    case 'MEDIUM':
      return 2;
    case 'LOW':
      return 3;
    default:
      return 4;
  }
}

function shorten(text: string | null, max: number): string {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function affiliateKey(name: string | null, code: string | null): string {
  return name ?? code ?? 'Unassigned';
}

/** Apply the model-side filters (risk bucket, and overdue-only) to the dataset. */
export function applyModelFilters(
  dataset: ReportDataset,
  filters: ReportFilters,
  now: Date,
): ReportDataset {
  const riskSet = new Set(filters.risks);
  const observations = dataset.observations.filter((o) => {
    const b = normaliseRisk(o.riskRating);
    return b != null && riskSet.has(b);
  });
  const obsIds = new Set(observations.map((o) => o.id));
  let actionPlans = dataset.actionPlans.filter((ap) => {
    const b = normaliseRisk(ap.observationRisk);
    return (b != null && riskSet.has(b)) || (ap.workPaperId != null && obsIds.has(ap.workPaperId));
  });
  if (filters.overdueOnly) {
    actionPlans = actionPlans.filter((ap) => isPlanOverdue(ap, now));
    const overdueObs = new Set(actionPlans.map((ap) => ap.workPaperId).filter(Boolean) as string[]);
    return { observations: observations.filter((o) => overdueObs.has(o.id)), actionPlans };
  }
  return { observations, actionPlans };
}

// ---- Executive Summary -----------------------------------------------------

function riskDistribution(observations: Observation[]): ReportBlock {
  const total = observations.length;
  const counts = new Map<RiskBucket, number>();
  for (const b of RISK_BUCKETS) counts.set(b, 0);
  for (const o of observations) {
    const b = normaliseRisk(o.riskRating);
    if (b) counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const rows: Cell[][] = RISK_BUCKETS.map((b) => {
    const c = counts.get(b) ?? 0;
    return [
      { text: RISK_LABELS[b], tone: riskTone(b) },
      { text: String(c), align: 'right' },
      { text: `${percent(c, total)}%`, align: 'right' },
    ];
  });
  return { kind: 'table', title: 'Risk distribution', columns: ['Risk', 'Count', 'Percent'], rows };
}

function implementationStatus(
  actionPlans: ActionPlan[],
  labels?: Record<string, string>,
): ReportBlock {
  const total = actionPlans.length;
  const counts = new Map<string, number>();
  for (const ap of actionPlans) counts.set(ap.status, (counts.get(ap.status) ?? 0) + 1);
  const rows: Cell[][] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, c]) => [
      { text: humaniseStatus(status, labels) },
      { text: String(c), align: 'right' as const },
      { text: `${percent(c, total)}%`, align: 'right' as const },
    ]);
  return {
    kind: 'table',
    title: 'Implementation status',
    columns: ['Status', 'Count', 'Percent'],
    rows,
  };
}

interface Rollup {
  key: string;
  observations: number;
  actionPlans: number;
  implemented: number;
  overdue: number;
}

function rollup(
  observations: Observation[],
  actionPlans: ActionPlan[],
  now: Date,
  obsKey: (o: Observation) => string,
  apKey: (ap: ActionPlan) => string,
): Rollup[] {
  const map = new Map<string, Rollup>();
  const get = (key: string): Rollup => {
    let r = map.get(key);
    if (!r) {
      r = { key, observations: 0, actionPlans: 0, implemented: 0, overdue: 0 };
      map.set(key, r);
    }
    return r;
  };
  for (const o of observations) get(obsKey(o)).observations += 1;
  for (const ap of actionPlans) {
    const r = get(apKey(ap));
    r.actionPlans += 1;
    if (isImplemented(ap)) r.implemented += 1;
    if (isPlanOverdue(ap, now)) r.overdue += 1;
  }
  return [...map.values()].sort(
    (a, b) => b.observations - a.observations || b.actionPlans - a.actionPlans,
  );
}

function byAffiliate(
  observations: Observation[],
  actionPlans: ActionPlan[],
  now: Date,
): ReportBlock {
  const rows: Cell[][] = rollup(
    observations,
    actionPlans,
    now,
    (o) => affiliateKey(o.affiliateName, o.affiliateCode),
    (ap) => ap.observationAffiliate ?? 'Unassigned',
  ).map((r) => {
    const rate = percent(r.implemented, r.actionPlans);
    return [
      { text: r.key },
      { text: String(r.observations), align: 'right' as const },
      { text: String(r.actionPlans), align: 'right' as const },
      { text: String(r.implemented), align: 'right' as const },
      {
        text: String(r.overdue),
        align: 'right' as const,
        tone: r.overdue > 0 ? ('bad' as const) : undefined,
      },
      { text: `${rate}%`, align: 'right' as const, tone: implementationTone(rate) },
    ];
  });
  return {
    kind: 'table',
    title: 'By affiliate',
    columns: [
      'Affiliate',
      'Observations',
      'Action plans',
      'Implemented',
      'Overdue',
      'Implementation rate',
    ],
    rows,
  };
}

function byAuditArea(
  observations: Observation[],
  actionPlans: ActionPlan[],
  now: Date,
): ReportBlock {
  const rows: Cell[][] = rollup(
    observations,
    actionPlans,
    now,
    (o) => o.auditAreaName ?? 'Unassigned',
    (ap) => ap.observationAuditArea ?? 'Unassigned',
  ).map((r) => {
    const rate = percent(r.implemented, r.actionPlans);
    return [
      { text: r.key },
      { text: String(r.observations), align: 'right' as const },
      { text: String(r.actionPlans), align: 'right' as const },
      { text: `${rate}%`, align: 'right' as const, tone: implementationTone(rate) },
    ];
  });
  return {
    kind: 'table',
    title: 'By audit area',
    columns: ['Audit area', 'Observations', 'Action plans', 'Implementation rate'],
    rows,
  };
}

function executiveSummary(
  data: ReportDataset,
  now: Date,
  labels?: Record<string, string>,
): ReportBlock[] {
  const { observations, actionPlans } = data;
  const implemented = actionPlans.filter(isImplemented).length;
  const overdue = actionPlans.filter((ap) => isPlanOverdue(ap, now)).length;
  const rate = percent(implemented, actionPlans.length);
  const kpis: Kpi[] = [
    { label: 'Total observations', value: String(observations.length) },
    { label: 'Total action plans', value: String(actionPlans.length) },
    { label: 'Implementation rate', value: `${rate}%`, tone: implementationTone(rate) },
    { label: 'Overdue items', value: String(overdue), tone: overdue > 0 ? 'bad' : 'good' },
  ];
  return [
    { kind: 'kpis', items: kpis },
    riskDistribution(observations),
    implementationStatus(actionPlans, labels),
    byAffiliate(observations, actionPlans, now),
    byAuditArea(observations, actionPlans, now),
  ];
}

// ---- Detailed Observations -------------------------------------------------

function detailedObservations(
  data: ReportDataset,
  now: Date,
  labels?: Record<string, string>,
): ReportBlock[] {
  const plansByObs = new Map<string, ActionPlan[]>();
  for (const ap of data.actionPlans) {
    if (!ap.workPaperId) continue;
    const list = plansByObs.get(ap.workPaperId) ?? [];
    list.push(ap);
    plansByObs.set(ap.workPaperId, list);
  }
  const sorted = [...data.observations].sort((a, b) => {
    const r = riskRank(normaliseRisk(a.riskRating)) - riskRank(normaliseRisk(b.riskRating));
    if (r !== 0) return r;
    return (parseMs(b.workPaperDate) ?? 0) - (parseMs(a.workPaperDate) ?? 0);
  });
  const rows: Cell[][] = sorted.map((o) => {
    const plans = plansByObs.get(o.id) ?? [];
    const overdue = plans.filter((ap) => isPlanOverdue(ap, now)).length;
    const bucket = normaliseRisk(o.riskRating);
    const title = o.observationTitle || 'Untitled observation';
    const desc = shorten(o.observationDescription, 100);
    return [
      { text: o.reference },
      {
        text: bucket ? RISK_LABELS[bucket] : (o.riskRating ?? '-'),
        tone: bucket ? riskTone(bucket) : undefined,
      },
      { text: desc ? `${title}: ${desc}` : title },
      { text: o.affiliateName ?? o.affiliateCode ?? '-' },
      { text: o.auditAreaName ?? '-' },
      { text: humaniseStatus(o.status, labels) },
      { text: o.responseStatus },
      { text: String(plans.length), align: 'right' },
      { text: String(overdue), align: 'right', tone: overdue > 0 ? 'bad' : undefined },
      { text: shorten(o.recommendation, 120) },
    ];
  });
  return [
    {
      kind: 'table',
      title: `Observations (${sorted.length})`,
      columns: [
        'Number',
        'Risk',
        'Observation',
        'Affiliate',
        'Audit area',
        'Status',
        'Response',
        'Plans',
        'Overdue',
        'Recommendation',
      ],
      rows,
    },
  ];
}

// ---- Action Plan Tracker ---------------------------------------------------

function actionPlanTracker(
  data: ReportDataset,
  now: Date,
  labels?: Record<string, string>,
): ReportBlock[] {
  const groups = new Map<string, ActionPlan[]>();
  for (const ap of data.actionPlans) {
    const key = ap.workPaperId ?? '_unlinked';
    const list = groups.get(key) ?? [];
    list.push(ap);
    groups.set(key, list);
  }
  const blocks: ReportBlock[] = [];
  const ordered = [...groups.entries()].sort((a, b) => {
    const ra = riskRank(normaliseRisk(a[1][0]?.observationRisk ?? null));
    const rb = riskRank(normaliseRisk(b[1][0]?.observationRisk ?? null));
    if (ra !== rb) return ra - rb;
    return (a[1][0]?.observationTitle ?? '').localeCompare(b[1][0]?.observationTitle ?? '');
  });
  for (const [, plans] of ordered) {
    const head = plans[0];
    const bucket = normaliseRisk(head?.observationRisk ?? null);
    const badges = [
      ...(bucket ? [{ text: RISK_LABELS[bucket], tone: riskTone(bucket) }] : []),
      ...(head?.observationAffiliate ? [{ text: head.observationAffiliate }] : []),
      ...(head?.observationStatus
        ? [{ text: humaniseStatus(head.observationStatus, labels) }]
        : []),
    ];
    const rows: Cell[][] = [...plans]
      .sort((a, b) => (parseMs(a.dueDate) ?? Infinity) - (parseMs(b.dueDate) ?? Infinity))
      .map((ap) => {
        const od = daysOverdue(ap, now);
        return [
          { text: ap.actionNumber },
          { text: shorten(ap.description, 80) },
          { text: ap.ownerNames ?? 'Unassigned' },
          { text: ap.dueDate ? ap.dueDate.slice(0, 10) : '-' },
          { text: humaniseStatus(ap.status, labels) },
          {
            text: od > 0 ? String(od) : '-',
            align: 'right' as const,
            tone: od > 0 ? ('bad' as const) : undefined,
          },
          { text: shorten(ap.implementationNotes, 80) },
        ];
      });
    blocks.push({
      kind: 'group',
      title: head?.observationTitle || head?.observationReference || 'Unlinked action plans',
      subtitle: head?.observationReference ?? undefined,
      badges,
      columns: ['Number', 'Description', 'Owner', 'Due date', 'Status', 'Days overdue', 'Notes'],
      rows,
    });
  }
  if (blocks.length === 0) {
    blocks.push({ kind: 'note', text: 'No action plans match the filters.' });
  }
  return blocks;
}

// ---- Overdue and At-Risk ---------------------------------------------------

function overdueAtRisk(
  data: ReportDataset,
  now: Date,
  labels?: Record<string, string>,
): ReportBlock[] {
  const overdue = data.actionPlans
    .filter((ap) => isPlanOverdue(ap, now))
    .map((ap) => ({ ap, days: daysOverdue(ap, now) }))
    .sort((a, b) => b.days - a.days);
  const atRisk = data.actionPlans
    .map((ap) => ({ ap, until: daysUntilDue(ap, now) }))
    .filter(
      (x) =>
        !isPlanOverdue(x.ap, now) && x.until != null && x.until >= 0 && x.until <= AT_RISK_DAYS,
    )
    .sort((a, b) => (a.until ?? 0) - (b.until ?? 0));
  const avg = overdue.length
    ? Math.round(overdue.reduce((s, x) => s + x.days, 0) / overdue.length)
    : 0;

  const overdueRows: Cell[][] = overdue.map(({ ap, days }) => [
    { text: ap.actionNumber },
    { text: shorten(ap.description, 80) },
    { text: ap.ownerNames ?? 'Unassigned' },
    { text: ap.observationAffiliate ?? '-' },
    { text: ap.dueDate ? ap.dueDate.slice(0, 10) : '-' },
    { text: String(days), align: 'right', tone: 'bad' },
    { text: humaniseStatus(ap.status, labels) },
  ]);
  const atRiskRows: Cell[][] = atRisk.map(({ ap, until }) => [
    { text: ap.actionNumber },
    { text: shorten(ap.description, 80) },
    { text: ap.ownerNames ?? 'Unassigned' },
    { text: ap.observationAffiliate ?? '-' },
    { text: ap.dueDate ? ap.dueDate.slice(0, 10) : '-' },
    { text: String(until ?? 0), align: 'right', tone: 'warn' },
    { text: humaniseStatus(ap.status, labels) },
  ]);

  const kpis: Kpi[] = [
    {
      label: 'Total overdue',
      value: String(overdue.length),
      tone: overdue.length > 0 ? 'bad' : 'good',
    },
    {
      label: 'At risk (14 days)',
      value: String(atRisk.length),
      tone: atRisk.length > 0 ? 'warn' : 'good',
    },
    { label: 'Average days overdue', value: String(avg) },
  ];
  return [
    { kind: 'kpis', items: kpis },
    {
      kind: 'table',
      title: `Overdue (${overdue.length})`,
      columns: [
        'Number',
        'Description',
        'Owner',
        'Affiliate',
        'Due date',
        'Days overdue',
        'Status',
      ],
      rows: overdueRows,
    },
    {
      kind: 'table',
      title: `At risk within ${AT_RISK_DAYS} days (${atRisk.length})`,
      columns: [
        'Number',
        'Description',
        'Owner',
        'Affiliate',
        'Due date',
        'Days until due',
        'Status',
      ],
      rows: atRiskRows,
    },
  ];
}

// ---- Assembly --------------------------------------------------------------

export interface BuildOptions {
  header: ReportHeader;
  now: Date;
  /** Real enum labels for statuses; humanised when absent. */
  statusLabels?: Record<string, string>;
}

/** Build the report document for the selected type from the scoped dataset. */
export function buildReport(
  dataset: ReportDataset,
  filters: ReportFilters,
  opts: BuildOptions,
): ReportDocument {
  const data = applyModelFilters(dataset, filters, opts.now);
  const labels = opts.statusLabels;
  let blocks: ReportBlock[];
  switch (filters.reportType) {
    case 'observations':
      blocks = detailedObservations(data, opts.now, labels);
      break;
    case 'tracker':
      blocks = actionPlanTracker(data, opts.now, labels);
      break;
    case 'overdue':
      blocks = overdueAtRisk(data, opts.now, labels);
      break;
    case 'executive':
    default:
      blocks = executiveSummary(data, opts.now, labels);
      break;
  }
  return { header: opts.header, blocks };
}
