/**
 * Shared types for the board reporting module. The report is built in two steps:
 * the repo returns a scoped ReportDataset (observations and action plans for the
 * acting organisation), and the pure model turns that plus the filters into a
 * generic ReportDocument. The same ReportDocument is rendered to HTML for the
 * preview and to a Word document for the export, so the two never drift.
 *
 * No runtime dependencies live here; these are types only.
 */

/**
 * The report types. `executive` is the period audit report for an affiliate and
 * period; `barc` is the Board Audit and Risk Committee pack, a portfolio view
 * across affiliates; `trend` is the observation trend over periods; `tracker`
 * is the action-plan status summary. `observations` and `overdue` are the
 * detailed and exception views the source board report also carries.
 */
export type ReportType = 'executive' | 'barc' | 'observations' | 'trend' | 'tracker' | 'overdue';

/** The four risk buckets the board report groups by (source labels). */
export type RiskBucket = 'EXTREME' | 'HIGH' | 'MEDIUM' | 'LOW';

/** A normalised observation (work paper) for reporting. */
export interface Observation {
  id: string;
  reference: string;
  riskRating: string | null;
  observationTitle: string;
  observationDescription: string | null;
  affiliateCode: string | null;
  affiliateName: string | null;
  auditAreaName: string | null;
  status: string;
  /** Derived auditee response state (Responded, Awaiting response, Not sent). */
  responseStatus: string;
  recommendation: string | null;
  workPaperDate: string | null;
  year: number | null;
  /** What the finding means for the business, from the work paper's risk summary. */
  implications: string | null;
  /** Who owns the finding: the assigned auditor, and the responsible parties. */
  responsibility: string | null;
  /** The latest management response recorded for the finding. */
  managementResponse: string | null;
}

/** A normalised action plan for reporting, carrying its observation context. */
export interface ActionPlan {
  id: string;
  actionNumber: string;
  workPaperId: string | null;
  description: string;
  ownerNames: string | null;
  dueDate: string | null;
  status: string;
  implementationNotes: string | null;
  observationTitle: string | null;
  observationReference: string | null;
  observationRisk: string | null;
  observationAffiliate: string | null;
  observationAuditArea: string | null;
  observationStatus: string | null;
}

/** The scoped dataset the repo returns for the acting organisation and role. */
export interface ReportDataset {
  observations: Observation[];
  actionPlans: ActionPlan[];
}

/** The report builder's filter state. */
export interface ReportFilters {
  /** A specific year, or null for all years. */
  year: number | null;
  /** Inclusive date range (YYYY-MM-DD); defaults to the last six months. */
  dateFrom: string;
  dateTo: string;
  affiliateCode: string | null;
  auditAreaId: string | null;
  /** The risk buckets to include (all on by default). */
  risks: RiskBucket[];
  /** The work-paper statuses to include. */
  statuses: string[];
  overdueOnly: boolean;
  reportType: ReportType;
}

// ---- The generic report document (rendered to HTML and to Word) ------------

/** A cell or KPI tone, mapped to the brand palette by each renderer. */
export type Tone =
  | 'default'
  | 'good'
  | 'warn'
  | 'bad'
  | 'muted'
  | 'risk-extreme'
  | 'risk-high'
  | 'risk-medium'
  | 'risk-low';

export interface Cell {
  text: string;
  tone?: Tone;
  align?: 'left' | 'right';
}

export interface Kpi {
  label: string;
  value: string;
  tone?: Tone;
}

export interface Badge {
  text: string;
  tone?: Tone;
}

export type ReportBlock =
  | { kind: 'kpis'; items: Kpi[] }
  | { kind: 'table'; title?: string; columns: string[]; rows: Cell[][] }
  | {
      kind: 'group';
      title: string;
      subtitle?: string;
      badges?: Badge[];
      columns: string[];
      rows: Cell[][];
    }
  | { kind: 'note'; text: string }
  // The house-style report sections: a numbered heading opens each part of the
  // document (introduction, executive summary, review summary, the detailed
  // observations, the appendices).
  | { kind: 'heading'; text: string; level: 1 | 2 }
  /** An analytical paragraph: the "summary" half of summary-plus-proof. */
  | { kind: 'narrative'; text: string }
  /** A numbered list, for an observation's recommendations. */
  | { kind: 'list'; title?: string; items: string[]; ordered?: boolean };

export interface ReportHeader {
  organisation: string;
  documentTitle: string;
  reportLabel: string;
  generatedAt: string;
  filterSummary: string;
  scopeNotice?: string;
}

export interface ReportDocument {
  header: ReportHeader;
  blocks: ReportBlock[];
}
