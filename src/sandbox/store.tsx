import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import { createSeedState } from './loadSeed';
import type {
  ActionPlanStatus,
  Finding,
  SandboxAction,
  SandboxState,
  WorkPaper,
} from './types';

const STORAGE_KEY = 'murikah.assurance-os.sandbox.v2';

function logEntry(state: SandboxState, action: string, entityType: string, entityId: string, details: string, before: Record<string, unknown> | null = null, after: Record<string, unknown> | null = null) {
  return {
    auditId: `LOG-USER-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    actorUserId: state.activeUserId,
    actorRole: state.activeRoleCode,
    action,
    entityType,
    entityId,
    createdAt: new Date().toISOString(),
    before,
    after,
    details,
  };
}

function nextFindingId(state: SandboxState): string {
  const max = state.findings.reduce((n, finding) => {
    const value = Number(finding.id.split('-').at(-1));
    return Number.isFinite(value) ? Math.max(n, value) : n;
  }, 0);
  return `AUD-2026-${String(max + 1).padStart(3, '0')}`;
}

function defaultWorkPaper(state: SandboxState, finding: Finding): WorkPaper {
  const engagement = state.engagements.find((item) => item.engagementId === finding.engagementId);
  const auditor = state.users.find((user) => user.userId === state.activeUserId);
  const id = `WP-2026-${String(state.workPapers.length + 1).padStart(3, '0')}`;
  return {
    workPaperId: id,
    workPaperRef: id.replace('2026-', ''),
    engagementId: finding.engagementId,
    year: new Date().getFullYear(),
    affiliateCode: engagement?.affiliateCode ?? state.activeAffiliateCode,
    auditAreaId: `AA-${finding.process.toUpperCase().slice(0, 3)}`,
    subAreaId: 'SA-DEMO',
    workPaperDate: new Date().toISOString(),
    auditPeriodFrom: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    auditPeriodTo: new Date().toISOString(),
    controlObjectives: 'Confirm that the selected control is designed, authorised and evidenced.',
    classification: 'Key control',
    controlType: 'Detective',
    controlFrequency: 'Monthly',
    standards: finding.criteria,
    riskDescription: finding.riskSummary,
    testObjective: 'Determine whether the control operated as designed for the selected sample.',
    testingSteps: ['Reconcile the population.', 'Inspect the selected sample.', 'Record and corroborate exceptions.'],
    observationTitle: finding.observationTitle,
    observationDescription: finding.observationDescription,
    riskRating: finding.riskRating,
    riskSummary: finding.riskSummary,
    recommendation: finding.recommendation,
    managementResponse: finding.managementResponse,
    assignedAuditorId: state.activeUserId,
    assignedAuditorName: auditor?.fullName,
    status: 'Draft',
    signOffState: 'Open',
    preparerId: state.activeUserId,
    reviewerId: engagement?.reviewerId ?? 'USR-AM',
    reviewNotes: [],
    evidence: [],
  };
}

export function sandboxReducer(state: SandboxState, action: SandboxAction): SandboxState {
  switch (action.type) {
    case 'NAVIGATE':
      return { ...state, screen: action.screen, selectedFindingId: null, selectedWorkPaperId: null };
    case 'SWITCH_ROLE': {
      const user = state.users.find((item) => item.userId === action.userId);
      if (!user) return state;
      const entry = logEntry(state, 'ROLE_SWITCHED', 'user', user.userId, `Role switched to ${user.roleLabel}`, { role: state.activeRoleCode }, { role: user.roleCode });
      return { ...state, activeUserId: user.userId, activeRoleCode: user.roleCode, auditLog: [entry, ...state.auditLog] };
    }
    case 'SWITCH_ENTITY':
      return { ...state, activeAffiliateCode: action.affiliateCode };
    case 'SELECT_ENGAGEMENT':
      return { ...state, selectedEngagementId: action.engagementId, selectedWorkPaperId: null };
    case 'SELECT_FINDING':
      return { ...state, selectedFindingId: action.findingId };
    case 'SELECT_WORK_PAPER':
      return { ...state, selectedWorkPaperId: action.workPaperId };
    case 'RESCHEDULE_ENGAGEMENT': {
      const before = state.engagements.find((item) => item.engagementId === action.engagementId);
      const engagements = state.engagements.map((item) =>
        item.engagementId === action.engagementId ? { ...item, quarter: action.quarter } : item,
      );
      const entry = logEntry(state, 'ENGAGEMENT_RESCHEDULED', 'engagement', action.engagementId, `Engagement moved to ${action.quarter}`, { quarter: before?.quarter }, { quarter: action.quarter });
      return { ...state, engagements, auditLog: [entry, ...state.auditLog] };
    }
    case 'UPDATE_ACTION_STATUS': {
      const existing = state.actionPlans.find((item) => item.actionPlanId === action.actionPlanId);
      if (!existing || existing.status === action.status) return state;
      const now = new Date().toISOString();
      const actionPlans = state.actionPlans.map((item) =>
        item.actionPlanId === action.actionPlanId
          ? {
              ...item,
              status: action.status,
              activity: [
                ...item.activity,
                { id: `${item.actionPlanId}-${Date.now()}`, label: `Status changed to ${action.status}`, createdAt: now, actor: state.activeRoleCode, kind: 'status' },
              ],
            }
          : item,
      );
      const entry = logEntry(state, 'ACTION_PLAN_STATUS_CHANGED', 'action_plan', action.actionPlanId, `Status changed from ${existing.status} to ${action.status}`, { status: existing.status }, { status: action.status });
      return {
        ...state,
        actionPlans,
        auditLog: [entry, ...state.auditLog],
        undo: { label: `Changed ${existing.actionPlanRef} to ${action.status}`, actionPlanId: action.actionPlanId, previousActionStatus: existing.status },
      };
    }
    case 'UPDATE_FINDING': {
      const existing = state.findings.find((item) => item.id === action.findingId);
      if (!existing) return state;
      const findings = state.findings.map((item) =>
        item.id === action.findingId ? { ...item, ...action.patch } : item,
      );
      const entry = logEntry(state, 'FINDING_UPDATED', 'work_paper', existing.workPaperId, action.reason ?? `Finding ${existing.id} updated`, existing as unknown as Record<string, unknown>, action.patch as Record<string, unknown>);
      return { ...state, findings, auditLog: [entry, ...state.auditLog], undo: { label: `Updated ${existing.id}`, findingId: existing.id, previousFinding: existing } };
    }
    case 'SET_FINDING_DRAFT':
      return { ...state, findingDraft: { ...state.findingDraft, ...action.patch } };
    case 'CREATE_FINDING_FROM_DRAFT': {
      const draft = state.findingDraft;
      if (!draft.condition.trim() || !draft.criteria.trim() || !draft.cause.trim() || !draft.effect.trim() || !draft.riskRating || !draft.recommendation.trim()) return state;
      const id = nextFindingId(state);
      const wpId = `WP-2026-${String(state.workPapers.length + 1).padStart(3, '0')}`;
      const engagement = state.engagements.find((item) => item.engagementId === draft.engagementId) ?? state.engagements[0];
      const ownerId = draft.process === 'ICT' ? 'USR-ICT' : 'USR-FIN';
      const finding: Finding = {
        id,
        workPaperId: wpId,
        engagementId: engagement.engagementId,
        observationTitle: draft.condition.split(/[.!?]/)[0].slice(0, 96) || 'New audit finding',
        observationDescription: draft.condition,
        process: draft.process,
        riskRating: draft.riskRating,
        riskSummary: draft.effect,
        rootCause: draft.cause,
        criteria: draft.criteria,
        recommendation: draft.recommendation,
        managementResponse: '',
        assignedAuditorId: state.activeUserId,
        ownerId,
        status: 'Draft',
        dueOffsetDays: 30,
        dueDate: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        createdOffsetDays: 0,
        createdAt: new Date().toISOString(),
        affiliateCode: engagement.affiliateCode,
        evidenceIds: [],
        activity: [{ id: `${id}-created`, label: 'Finding created in sandbox', createdAt: new Date().toISOString(), actor: state.activeRoleCode, kind: 'finding' }],
      };
      const workPaper = defaultWorkPaper(state, finding);
      const entry = logEntry(state, 'WORK_PAPER_CREATED', 'work_paper', wpId, `Created ${id} from the finding workflow`, null, { findingId: id });
      return {
        ...state,
        findings: [finding, ...state.findings],
        workPapers: [workPaper, ...state.workPapers],
        selectedFindingId: id,
        auditLog: [entry, ...state.auditLog],
        findingDraft: { ...draft, step: 1, condition: '', criteria: '', cause: '', effect: '', riskRating: '', recommendation: '' },
      };
    }
    case 'SIGN_OFF_WORK_PAPER': {
      const existing = state.workPapers.find((item) => item.workPaperId === action.workPaperId);
      if (!existing) return state;
      const statusMap: Record<WorkPaper['signOffState'], WorkPaper['status']> = { Open: 'Draft', Prepared: 'Submitted', Reviewed: 'Under Review', Approved: 'Approved' };
      const workPapers = state.workPapers.map((item) => item.workPaperId === action.workPaperId ? { ...item, signOffState: action.state, status: statusMap[action.state] } : item);
      const entry = logEntry(state, 'WORK_PAPER_SIGNOFF', 'work_paper', action.workPaperId, `Work paper moved to ${action.state}`, { state: existing.signOffState }, { state: action.state });
      return { ...state, workPapers, auditLog: [entry, ...state.auditLog] };
    }
    case 'ADD_REVIEW_NOTE': {
      const text = action.text.trim();
      if (!text) return state;
      const workPapers = state.workPapers.map((item) => item.workPaperId === action.workPaperId ? { ...item, reviewNotes: [...item.reviewNotes, { id: `RN-${Date.now()}`, authorId: state.activeUserId, createdAt: new Date().toISOString(), text }] } : item);
      const entry = logEntry(state, 'REVIEW_NOTE_ADDED', 'work_paper', action.workPaperId, text);
      return { ...state, workPapers, auditLog: [entry, ...state.auditLog] };
    }
    case 'ACCEPT_AI_DRAFT': {
      if (action.entityType === 'finding') {
        const patch = action.field === 'rootCause' ? { rootCause: action.text } : action.field === 'recommendation' ? { recommendation: action.text } : {};
        const findings = state.findings.map((item) => item.id === action.entityId ? { ...item, ...patch } : item);
        const entry = logEntry(state, 'AI_DRAFT_ACCEPTED', 'work_paper', action.entityId, `AI-assisted draft accepted by ${state.activeRoleCode}`, null, { field: action.field });
        return { ...state, findings, auditLog: [entry, ...state.auditLog] };
      }
      const workPapers = state.workPapers.map((item) => item.workPaperId === action.entityId ? { ...item, observationDescription: action.field === 'observationDescription' ? action.text : item.observationDescription, recommendation: action.field === 'recommendation' ? action.text : item.recommendation } : item);
      const entry = logEntry(state, 'AI_DRAFT_ACCEPTED', 'work_paper', action.entityId, `AI-assisted draft accepted by ${state.activeRoleCode}`, null, { field: action.field });
      return { ...state, workPapers, auditLog: [entry, ...state.auditLog] };
    }
    case 'SAVE_FINDING_VIEW':
      return { ...state, savedFindingViews: [...state.savedFindingViews, { id: `VIEW-${Date.now()}`, name: action.name, filters: action.filters }] };
    case 'MARK_NOTIFICATION':
      return { ...state, notifications: state.notifications.map((item) => item.id === action.id ? { ...item, read: true } : item) };
    case 'DISMISS_TOUR':
      return { ...state, tourDismissed: true };
    case 'UNDO_LAST': {
      if (!state.undo) return state;
      if (state.undo.actionPlanId && state.undo.previousActionStatus) {
        const status = state.undo.previousActionStatus as ActionPlanStatus;
        return { ...state, actionPlans: state.actionPlans.map((item) => item.actionPlanId === state.undo?.actionPlanId ? { ...item, status } : item), undo: null };
      }
      if (state.undo.findingId && state.undo.previousFinding) {
        return { ...state, findings: state.findings.map((item) => item.id === state.undo?.findingId ? { ...item, ...state.undo?.previousFinding } : item), undo: null };
      }
      return { ...state, undo: null };
    }
    case 'RESET':
      return action.state;
    default:
      return state;
  }
}

function readPersisted(): SandboxState {
  if (typeof window === 'undefined') return createSeedState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createSeedState();
    const parsed = JSON.parse(raw) as SandboxState;
    if (parsed.version !== 2) return createSeedState();
    return parsed;
  } catch {
    return createSeedState();
  }
}

const SandboxContext = createContext<{ state: SandboxState; dispatch: Dispatch<SandboxAction>; reset: () => void } | null>(null);

export function SandboxProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sandboxReducer, undefined, readPersisted);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  const value = useMemo(() => ({
    state,
    dispatch,
    reset: () => {
      const seeded = createSeedState();
      window.localStorage.removeItem(STORAGE_KEY);
      dispatch({ type: 'RESET', state: seeded });
    },
  }), [state]);

  return <SandboxContext.Provider value={value}>{children}</SandboxContext.Provider>;
}

export function useSandbox() {
  const value = useContext(SandboxContext);
  if (!value) throw new Error('useSandbox must be used inside SandboxProvider');
  return value;
}

export { STORAGE_KEY };
