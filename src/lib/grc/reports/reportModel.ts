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
  { value: 'executive', label: 'Period Audit Report' },
  { value: 'barc', label: 'BARC Board Pack' },
  { value: 'observations', label: 'Detailed Observations' },
  { value: 'trend', label: 'Observation Trend' },
  { value: 'tracker', label: 'Action Plan Status Summary' },
  { value: 'overdue', label: 'Overdue and At-Risk' },
];

export const RISK_BUCKETS: RiskBucket[] = ['EXTREME', 'HIGH', 'MEDIUM', 'LOW'];

export const RISK_LABELS: Record<RiskBucket, string> = {
  EXTREME: 'Extreme',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

// Statuses are the human-readable strings the hassaudit schema stores (Build
// Prompt 16), matching the WP_STATUS and AP_STATUS labels in workflow/, so the
// report filters and queries agree with work_papers.status and
// action_plans.status exactly.

/** The work-paper statuses the report filters by, with their labels. */
export const STATUS_OPTIONS: { value: string; label: string; auditeeOnly?: boolean }[] = [
  { value: 'Approved', label: 'Approved' },
  { value: 'Sent to Auditee', label: 'Sent to Auditee' },
  { value: 'Submitted', label: 'Submitted', auditeeOnly: true },
  { value: 'Draft', label: 'Draft', auditeeOnly: true },
];

/** Statuses a UNIT_MANAGER never sees in the report (drafts and submissions). */
export const UNIT_MANAGER_HIDDEN_STATUSES = ['Draft', 'Submitted'];

/**
 * Action-plan statuses that are not counted as overdue: the plan is implemented
 * or otherwise settled. The source treats Implemented, Verified, Not Implemented,
 * Closed and Rejected as not-overdue; Pending Verification is the
 * implemented-and-awaiting-verification state in this build, settled from the
 * owner's side, so it is included here too.
 */
export const NOT_OVERDUE_STATUSES = [
  'Implemented',
  'Pending Verification',
  'Verified',
  'Not Implemented',
  'Closed',
  'Rejected',
];

/** Statuses that count towards the implementation rate. */
export const IMPLEMENTED_STATUSES = ['Implemented', 'Pending Verification', 'Verified', 'Closed'];

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

// ---- The house-style report frame ------------------------------------------

/**
 * Split a recommendation blob into the numbered points the house style wants.
 * Auditors write these as newline-separated lines, or as "1. ... 2. ..." in one
 * paragraph; both give the same list, and a single sentence stays one item.
 */
export function splitRecommendations(text: string | null): string[] {
  const raw = (text ?? '').trim();
  if (raw === '') return [];
  const lines = raw
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const source =
    lines.length > 1
      ? lines
      : // One line: split on embedded numbering such as "1." or "(2)", keeping
        // the text that follows each marker.
        raw
          .split(/(?:^|\s)(?:\(?\d{1,2}[.)])\s+/)
          .map((l) => l.trim())
          .filter(Boolean);
  return source.map((l) => l.replace(/^(?:\(?\d{1,2}[.)])\s*/, '').trim()).filter(Boolean);
}

/** The counts an introduction and executive narrative are written from. */
function portfolioFacts(data: ReportDataset, now: Date) {
  const { observations, actionPlans } = data;
  const implemented = actionPlans.filter(isImplemented).length;
  const overdue = actionPlans.filter((ap) => isPlanOverdue(ap, now)).length;
  const high = observations.filter((o) => {
    const b = normaliseRisk(o.riskRating);
    return b === 'EXTREME' || b === 'HIGH';
  }).length;
  const affiliates = new Set(
    observations.map((o) => affiliateKey(o.affiliateName, o.affiliateCode)),
  ).size;
  const responded = observations.filter((o) => o.responseStatus === 'Responded').length;
  return {
    observations: observations.length,
    actionPlans: actionPlans.length,
    implemented,
    overdue,
    high,
    affiliates,
    responded,
    rate: percent(implemented, actionPlans.length),
  };
}

/** The introduction: what the report covers and how to read it. */
function introduction(data: ReportDataset, filters: ReportFilters, now: Date): ReportBlock[] {
  const f = portfolioFacts(data, now);
  return [
    { kind: 'heading', text: '1. Introduction', level: 1 },
    {
      kind: 'narrative',
      text:
        `This report covers ${f.observations} audit ${plural(f.observations, 'observation')} ` +
        `raised across ${f.affiliates} ${plural(f.affiliates, 'affiliate')}, together with the ` +
        `${f.actionPlans} remediation ${plural(f.actionPlans, 'action plan')} agreed against them. ` +
        `${filterSummary(filters)}.`,
    },
    {
      kind: 'narrative',
      text:
        'Each observation is presented in the summary-and-proof style: a short analytical ' +
        'statement of what was found and why it matters, a compact evidence table, and the ' +
        'numbered recommendations agreed with management. The full detail of every observation ' +
        'is carried in the appendix.',
    },
  ];
}

/** The review summary: how the portfolio stands, in words before tables. */
function reviewSummary(data: ReportDataset, now: Date): ReportBlock[] {
  const f = portfolioFacts(data, now);
  const responseLine =
    f.observations === 0
      ? 'No observations fall within this scope.'
      : `Management has responded to ${f.responded} of ${f.observations} ` +
        `${plural(f.observations, 'observation')}.`;
  const overdueLine =
    f.overdue === 0
      ? 'No agreed action is past its due date.'
      : `${f.overdue} agreed ${plural(f.overdue, 'action')} ${f.overdue === 1 ? 'is' : 'are'} past ` +
        'the date management committed to, and require the committee’s attention.';
  return [
    { kind: 'heading', text: '3. Review summary', level: 1 },
    {
      kind: 'narrative',
      text:
        `${f.high} of the ${f.observations} ${plural(f.observations, 'observation')} ` +
        `${f.high === 1 ? 'carries' : 'carry'} a high or extreme risk rating. ` +
        `${f.implemented} of ${f.actionPlans} agreed ${plural(f.actionPlans, 'action')} ` +
        `${f.implemented === 1 ? 'has' : 'have'} been implemented, an implementation rate of ` +
        `${f.rate} per cent. ${overdueLine} ${responseLine}`,
    },
  ];
}

function plural(n: number, singular: string): string {
  return n === 1 ? singular : `${singular}s`;
}

// ---- BARC board pack -------------------------------------------------------

/**
 * The Board Audit and Risk Committee pack: the portfolio across affiliates
 * rather than one engagement, so the committee sees where risk and unfinished
 * remediation sit, and which affiliates are carrying them.
 */
function barcBoardPack(
  data: ReportDataset,
  now: Date,
  labels?: Record<string, string>,
): ReportBlock[] {
  const { observations, actionPlans } = data;
  const f = portfolioFacts(data, now);
  // Due within the at-risk window and not already overdue, the same reading the
  // overdue-and-at-risk report uses.
  const atRisk = actionPlans.filter((ap) => {
    if (isPlanOverdue(ap, now)) return false;
    const due = parseMs(ap.dueDate);
    if (due == null) return false;
    const until = daysBetween(now.getTime(), due);
    return until >= 0 && until <= AT_RISK_DAYS;
  }).length;
  const kpis: Kpi[] = [
    { label: 'Affiliates covered', value: String(f.affiliates) },
    { label: 'Observations', value: String(f.observations) },
    { label: 'High and extreme risk', value: String(f.high), tone: f.high > 0 ? 'bad' : 'good' },
    { label: 'Implementation rate', value: `${f.rate}%`, tone: implementationTone(f.rate) },
    { label: 'Overdue actions', value: String(f.overdue), tone: f.overdue > 0 ? 'bad' : 'good' },
    { label: 'Due within 14 days', value: String(atRisk), tone: atRisk > 0 ? 'warn' : undefined },
  ];
  return [
    { kind: 'heading', text: '4. Portfolio position', level: 1 },
    { kind: 'kpis', items: kpis },
    {
      kind: 'narrative',
      text:
        'The table below ranks affiliates by outstanding exposure, so the committee can see ' +
        'where remediation is lagging rather than only the group total.',
    },
    byAffiliate(observations, actionPlans, now),
    riskDistribution(observations),
    byAuditArea(observations, actionPlans, now),
    implementationStatus(actionPlans, labels),
  ];
}

// ---- Observation trend -----------------------------------------------------

/** The period an observation falls in, by its work paper date, else its year. */
function periodKey(o: Observation): string {
  const ms = parseMs(o.workPaperDate);
  if (ms == null) return o.year == null ? 'Undated' : String(o.year);
  const d = new Date(ms);
  const quarter = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()} Q${quarter}`;
}

/**
 * The observation trend: how many observations were raised per period and at
 * what risk, so the committee can see whether the control environment is
 * improving rather than reading a single point in time.
 */
function observationTrend(data: ReportDataset): ReportBlock[] {
  const { observations, actionPlans } = data;
  const periods = new Map<string, Observation[]>();
  for (const o of observations) {
    const key = periodKey(o);
    const list = periods.get(key) ?? [];
    list.push(o);
    periods.set(key, list);
  }
  // Undated observations sort last; everything else runs oldest to newest so the
  // direction of travel reads left to right.
  const keys = [...periods.keys()].sort((a, b) => {
    if (a === 'Undated') return 1;
    if (b === 'Undated') return -1;
    return a.localeCompare(b);
  });

  const plansByObs = new Map<string, ActionPlan[]>();
  for (const ap of actionPlans) {
    if (!ap.workPaperId) continue;
    const list = plansByObs.get(ap.workPaperId) ?? [];
    list.push(ap);
    plansByObs.set(ap.workPaperId, list);
  }

  const rows: Cell[][] = keys.map((key) => {
    const list = periods.get(key) ?? [];
    const count = (b: RiskBucket): number =>
      list.filter((o) => normaliseRisk(o.riskRating) === b).length;
    const plans = list.flatMap((o) => plansByObs.get(o.id) ?? []);
    const implemented = plans.filter(isImplemented).length;
    const rate = percent(implemented, plans.length);
    return [
      { text: key },
      { text: String(list.length), align: 'right' as const },
      { text: String(count('EXTREME')), align: 'right' as const },
      {
        text: String(count('HIGH')),
        align: 'right' as const,
        tone: count('HIGH') > 0 ? ('bad' as const) : undefined,
      },
      { text: String(count('MEDIUM')), align: 'right' as const },
      { text: String(count('LOW')), align: 'right' as const },
      { text: `${rate}%`, align: 'right' as const, tone: implementationTone(rate) },
    ];
  });

  const first = keys[0] ? (periods.get(keys[0])?.length ?? 0) : 0;
  const last = keys.length > 1 ? (periods.get(keys[keys.length - 1])?.length ?? 0) : first;
  const direction =
    keys.length < 2
      ? 'A single period is in scope, so no trend can be read yet.'
      : last > first
        ? `Observations raised have risen from ${first} in ${keys[0]} to ${last} in ${keys[keys.length - 1]}.`
        : last < first
          ? `Observations raised have fallen from ${first} in ${keys[0]} to ${last} in ${keys[keys.length - 1]}.`
          : `Observations raised have held steady at ${last} per period.`;

  return [
    { kind: 'heading', text: '4. Observation trend', level: 1 },
    { kind: 'narrative', text: direction },
    {
      kind: 'table',
      title: `By period (${keys.length} ${plural(keys.length, 'period')})`,
      columns: [
        'Period',
        'Observations',
        'Extreme',
        'High',
        'Medium',
        'Low',
        'Implementation rate',
      ],
      rows,
    },
    riskDistribution(observations),
  ];
}

// ---- Observations in the summary-and-proof style ---------------------------

/**
 * One observation written the way the house report presents it: an analytical
 * paragraph saying what was found and what it means, a compact evidence table
 * carrying the facts that support it, and the numbered recommendations. The
 * full narrative and management response go to the appendix, so the body reads
 * as analysis rather than as a data dump.
 */
function observationSection(
  o: Observation,
  index: number,
  plans: ActionPlan[],
  now: Date,
  labels?: Record<string, string>,
): ReportBlock[] {
  // The risk label and its colour are the card model's business now: it reads
  // the stored rating itself, so the pack and the screen cannot disagree about
  // what "High" looks like (Build Prompt 67).
  const overdue = plans.filter((ap) => isPlanOverdue(ap, now)).length;
  const implemented = plans.filter(isImplemented).length;
  const title = o.observationTitle || 'Untitled observation';

  const remediation =
    plans.length === 0
      ? 'No remediation has been agreed for this observation.'
      : `${plans.length} ${plural(plans.length, 'action')} agreed, of which ${implemented} ` +
        `${implemented === 1 ? 'has' : 'have'} been implemented` +
        (overdue > 0 ? ` and ${overdue} ${overdue === 1 ? 'is' : 'are'} overdue.` : '.');

  // The finding as the shared arrangement draws it (Build Prompt 67): the header
  // strip with its risk pill, audit's three cards as one group, then what
  // management said and what they agreed to do. The board pack and the work
  // paper's own screen now render from the same model through the same
  // component, so a pack cannot quietly disagree with the screen it was
  // approved from. The narrative that used to open each observation is gone
  // with it: it was a paragraph assembled out of the same fields the cards now
  // show properly, and reading both was reading the finding twice.
  const blocks: ReportBlock[] = [
    { kind: 'heading', text: `5.${index} ${title}`, level: 2 },
    {
      kind: 'finding',
      source: {
        reference: o.reference,
        observationTitle: title,
        observationDescription: o.observationDescription ?? '',
        affiliate: o.affiliateName ?? o.affiliateCode ?? '',
        auditArea: o.auditAreaName ?? '',
        // The report dataset carries the area but not the sub-area, so the
        // strip shows the area and leaves the sub-area blank rather than
        // inventing one.
        subArea: '',
        status: humaniseStatus(o.status, labels),
        riskRating: o.riskRating,
        riskSummary: o.implications ?? '',
        recommendation: o.recommendation ?? '',
        managementResponse: o.managementResponse ?? '',
        responsibility: o.responsibility ?? '',
        actionPlans: plans.map((ap) => ({
          description: shorten(ap.description, 160),
          owner: ap.ownerNames ?? 'Unassigned',
          due: ap.dueDate ?? '-',
          status: humaniseStatus(ap.status, labels),
        })),
      },
    },
    // The one line the cards cannot carry, because it is arithmetic across the
    // plans rather than a field on the finding.
    { kind: 'note', text: remediation },
  ];

  const recommendations = splitRecommendations(o.recommendation);
  if (recommendations.length > 0) {
    blocks.push({ kind: 'list', title: 'Recommendations', items: recommendations, ordered: true });
  }
  return blocks;
}

/** The appendix: the full text of every observation and its management response. */
function observationAppendix(observations: Observation[]): ReportBlock[] {
  if (observations.length === 0) return [];
  const blocks: ReportBlock[] = [
    { kind: 'heading', text: 'Appendix A: observations in full', level: 1 },
    {
      kind: 'narrative',
      text:
        'The complete text of each observation, its implications and the response management ' +
        'recorded, in the order the observations appear above.',
    },
  ];
  for (const [i, o] of observations.entries()) {
    blocks.push({
      kind: 'heading',
      text: `A.${i + 1} ${o.reference}: ${o.observationTitle || 'Untitled observation'}`,
      level: 2,
    });
    blocks.push({
      kind: 'narrative',
      text: o.observationDescription ?? 'No detailed description was recorded.',
    });
    if (o.implications) {
      blocks.push({ kind: 'narrative', text: `Implications: ${o.implications}` });
    }
    blocks.push({
      kind: 'narrative',
      text: o.managementResponse
        ? `Management response: ${o.managementResponse}`
        : 'Management response: none recorded.',
    });
  }
  return blocks;
}

/** Observations sorted by risk, then most recent first. */
function sortedByRisk(observations: Observation[]): Observation[] {
  return [...observations].sort((a, b) => {
    const r = riskRank(normaliseRisk(a.riskRating)) - riskRank(normaliseRisk(b.riskRating));
    if (r !== 0) return r;
    return (parseMs(b.workPaperDate) ?? 0) - (parseMs(a.workPaperDate) ?? 0);
  });
}

/** The detailed observations part of the report, in the house style. */
function observationNarratives(
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
  const sorted = sortedByRisk(data.observations);
  const blocks: ReportBlock[] = [{ kind: 'heading', text: '5. Detailed observations', level: 1 }];
  if (sorted.length === 0) {
    blocks.push({
      kind: 'note',
      text: 'No observations fall within the selected scope.',
    });
    return blocks;
  }
  for (const [i, o] of sorted.entries()) {
    blocks.push(...observationSection(o, i + 1, plansByObs.get(o.id) ?? [], now, labels));
  }
  return blocks;
}

// ---- Detailed Observations (the dense table view) --------------------------

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

  // Every report is assembled in the house structure: the cover comes from the
  // header the renderers draw, then the introduction, the executive summary,
  // the review summary, the type's own body, and the appendices.
  const body: ReportBlock[] = [];
  let appendices: ReportBlock[] = [];

  switch (filters.reportType) {
    case 'barc':
      body.push(...barcBoardPack(data, opts.now, labels));
      body.push(...observationNarratives(data, opts.now, labels));
      appendices = observationAppendix(sortedByRisk(data.observations));
      break;
    case 'trend':
      body.push(...observationTrend(data));
      break;
    case 'observations':
      body.push(...observationNarratives(data, opts.now, labels));
      body.push({ kind: 'heading', text: '6. Observation register', level: 1 });
      body.push(...detailedObservations(data, opts.now, labels));
      appendices = observationAppendix(sortedByRisk(data.observations));
      break;
    case 'tracker':
      body.push({ kind: 'heading', text: '4. Action plan status', level: 1 });
      body.push(...actionPlanTracker(data, opts.now, labels));
      break;
    case 'overdue':
      body.push({ kind: 'heading', text: '4. Overdue and at-risk actions', level: 1 });
      body.push(...overdueAtRisk(data, opts.now, labels));
      break;
    case 'executive':
    default:
      body.push({ kind: 'heading', text: '4. Period audit summary', level: 1 });
      body.push(...executiveSummary(data, opts.now, labels));
      body.push(...observationNarratives(data, opts.now, labels));
      appendices = observationAppendix(sortedByRisk(data.observations));
      break;
  }

  const blocks: ReportBlock[] = [
    ...introduction(data, filters, opts.now),
    { kind: 'heading', text: '2. Executive summary', level: 1 },
    { kind: 'kpis', items: executiveKpis(data, opts.now) },
    ...reviewSummary(data, opts.now),
    ...body,
    ...appendices,
  ];
  return { header: opts.header, blocks };
}

/** The headline numbers the executive summary opens with. */
function executiveKpis(data: ReportDataset, now: Date): Kpi[] {
  const f = portfolioFacts(data, now);
  return [
    { label: 'Observations', value: String(f.observations) },
    { label: 'High and extreme risk', value: String(f.high), tone: f.high > 0 ? 'bad' : 'good' },
    { label: 'Action plans', value: String(f.actionPlans) },
    { label: 'Implementation rate', value: `${f.rate}%`, tone: implementationTone(f.rate) },
    { label: 'Overdue actions', value: String(f.overdue), tone: f.overdue > 0 ? 'bad' : 'good' },
  ];
}
