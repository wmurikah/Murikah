export type RoleCode =
  | 'HEAD_OF_AUDIT'
  | 'AUDIT_MANAGER'
  | 'SENIOR_AUDITOR'
  | 'AUDITOR'
  | 'BOARD_MEMBER'
  | 'UNIT_MANAGER';

export type ScreenId =
  | 'dashboard'
  | 'plan'
  | 'engagements'
  | 'findings'
  | 'actions'
  | 'risks'
  | 'reports'
  | 'audit-log';

export type EngagementStatus = 'Planned' | 'Fieldwork' | 'Review' | 'Reporting' | 'Closed';
export type FindingStatus =
  | 'Draft'
  | 'In review'
  | 'Issued'
  | 'Action in progress'
  | 'Overdue'
  | 'Closed';
export type RiskRating = 'Critical' | 'High' | 'Medium' | 'Low';

export type WorkPaperStatus =
  | 'Draft'
  | 'Submitted'
  | 'Under Review'
  | 'Approved'
  | 'Sent to Auditee'
  | 'Response Received'
  | 'Response Reviewed'
  | 'Revision Required';

export type ActionPlanStatus =
  | 'Not Due'
  | 'Pending'
  | 'In Progress'
  | 'Overdue'
  | 'Implemented'
  | 'Pending Verification'
  | 'Verified'
  | 'Closed'
  | 'Rejected';

export interface SandboxOrganization {
  organizationId: string;
  organizationName: string;
  sector: string;
  currency: string;
  entities: Array<{ affiliateCode: string; affiliateName: string; isGroup: boolean }>;
}

export interface SandboxUser {
  userId: string;
  fullName: string;
  email: string;
  roleCode: RoleCode;
  roleLabel: string;
  affiliateCode: string;
  process?: string;
  avatar: string;
}

export interface Engagement {
  engagementId: string;
  title: string;
  process: string;
  status: EngagementStatus;
  affiliateCode: string;
  startOffsetDays: number;
  endOffsetDays: number;
  startDate: string;
  endDate: string;
  leadAuditorId: string;
  reviewerId: string;
  quarter: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  budgetDays: number;
  progress: number;
  scope: string[];
  objectives: string;
}

export interface Finding {
  id: string;
  workPaperId: string;
  engagementId: string;
  observationTitle: string;
  observationDescription: string;
  process: string;
  riskRating: RiskRating;
  riskSummary: string;
  rootCause: string;
  criteria: string;
  recommendation: string;
  managementResponse: string;
  assignedAuditorId: string;
  ownerId: string;
  status: FindingStatus;
  dueOffsetDays: number;
  dueDate: string;
  createdOffsetDays: number;
  createdAt: string;
  affiliateCode: string;
  evidenceIds: string[];
  activity?: TimelineEvent[];
}

export interface EvidenceFile {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  sizeKb: number;
  uploadedOffsetDays?: number;
  uploadedAt: string;
  preview: string;
}

export interface ReviewNote {
  id: string;
  authorId: string;
  offsetDays?: number;
  createdAt: string;
  text: string;
}

export interface WorkPaper {
  workPaperId: string;
  workPaperRef: string;
  engagementId: string;
  year: number;
  affiliateCode: string;
  auditAreaId: string;
  subAreaId: string;
  workPaperDateOffsetDays?: number;
  workPaperDate: string;
  auditPeriodFromOffsetDays?: number;
  auditPeriodFrom: string;
  auditPeriodToOffsetDays?: number;
  auditPeriodTo: string;
  controlObjectives: string;
  classification: string;
  controlType: string;
  controlFrequency: string;
  standards: string;
  riskDescription: string;
  testObjective: string;
  testingSteps: string[];
  observationTitle: string;
  observationDescription: string;
  riskRating: RiskRating;
  riskSummary: string;
  recommendation: string;
  managementResponse: string;
  assignedAuditorId: string;
  assignedAuditorName?: string;
  status: WorkPaperStatus;
  signOffState: 'Open' | 'Prepared' | 'Reviewed' | 'Approved';
  preparerId: string;
  reviewerId: string;
  reviewNotes: ReviewNote[];
  evidence: EvidenceFile[];
}

export interface ActionPlan {
  actionPlanId: string;
  findingId: string;
  workPaperId: string;
  actionPlanRef: string;
  actionDescription: string;
  ownerIds: string[];
  dueOffsetDays: number;
  dueDate: string;
  priority: RiskRating;
  status: ActionPlanStatus;
  escalationState: string;
  reminderOffsetDays: number;
  reminderDate: string;
  createdOffsetDays: number;
  createdAt: string;
  evidence: Array<{ name: string; type: string; sizeKb: number }>;
  activity: TimelineEvent[];
}

export interface RiskRecord {
  riskId: string;
  title: string;
  process: string;
  ownerId: string;
  inherentLikelihood: number;
  inherentImpact: number;
  residualLikelihood: number;
  residualImpact: number;
  controlLinks: string[];
  appetite: string;
  treatment: string;
}

export interface AuditArea {
  auditAreaId: string;
  areaCode: string;
  areaName: string;
  description: string;
}

export interface NotificationItem {
  id: string;
  title: string;
  kind: string;
  offsetMinutes?: number;
  createdAt: string;
  read?: boolean;
}

export interface AuditLogEntry {
  auditId: string;
  actorUserId: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  offsetMinutes?: number;
  createdAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  details: string;
}

export interface TimelineEvent {
  id: string;
  label: string;
  createdAt: string;
  actor?: string;
  kind?: string;
}

export interface FindingDraft {
  step: number;
  condition: string;
  criteria: string;
  cause: string;
  effect: string;
  riskRating: RiskRating | '';
  recommendation: string;
  engagementId: string;
  process: string;
}

export interface SandboxState {
  version: 2;
  initializedAt: string;
  organization: SandboxOrganization;
  users: SandboxUser[];
  activeUserId: string;
  activeRoleCode: RoleCode;
  activeAffiliateCode: string;
  screen: ScreenId;
  selectedEngagementId: string | null;
  selectedFindingId: string | null;
  selectedWorkPaperId: string | null;
  engagements: Engagement[];
  findings: Finding[];
  actionPlans: ActionPlan[];
  workPapers: WorkPaper[];
  risks: RiskRecord[];
  auditUniverse: AuditArea[];
  auditLog: AuditLogEntry[];
  notifications: NotificationItem[];
  savedFindingViews: Array<{ id: string; name: string; filters: Record<string, string> }>;
  findingDraft: FindingDraft;
  tourDismissed: boolean;
  undo: null | {
    label: string;
    actionPlanId?: string;
    previousActionStatus?: ActionPlanStatus;
    findingId?: string;
    previousFinding?: Partial<Finding>;
  };
}

export type SandboxAction =
  | { type: 'NAVIGATE'; screen: ScreenId }
  | { type: 'SWITCH_ROLE'; userId: string }
  | { type: 'SWITCH_ENTITY'; affiliateCode: string }
  | { type: 'SELECT_ENGAGEMENT'; engagementId: string | null }
  | { type: 'SELECT_FINDING'; findingId: string | null }
  | { type: 'SELECT_WORK_PAPER'; workPaperId: string | null }
  | { type: 'RESCHEDULE_ENGAGEMENT'; engagementId: string; quarter: Engagement['quarter'] }
  | { type: 'UPDATE_ACTION_STATUS'; actionPlanId: string; status: ActionPlanStatus }
  | { type: 'ADD_ACTION_EVIDENCE'; actionPlanId: string; name: string; typeName: string; sizeKb: number }
  | { type: 'UPDATE_FINDING'; findingId: string; patch: Partial<Finding>; reason?: string }
  | { type: 'SET_FINDING_DRAFT'; patch: Partial<FindingDraft> }
  | { type: 'CREATE_FINDING_FROM_DRAFT' }
  | { type: 'SIGN_OFF_WORK_PAPER'; workPaperId: string; state: WorkPaper['signOffState'] }
  | { type: 'ADD_REVIEW_NOTE'; workPaperId: string; text: string }
  | { type: 'ACCEPT_AI_DRAFT'; entityType: 'finding' | 'work_paper'; entityId: string; field: string; text: string }
  | { type: 'SAVE_FINDING_VIEW'; name: string; filters: Record<string, string> }
  | { type: 'MARK_NOTIFICATION'; id: string }
  | { type: 'DISMISS_TOUR' }
  | { type: 'UNDO_LAST' }
  | { type: 'CLEAR_UNDO' }
  | { type: 'LOG_EVENT'; action: string; entityType: string; entityId: string; details: string }
  | { type: 'RESET'; state: SandboxState };
