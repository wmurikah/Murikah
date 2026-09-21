import organizationSeed from './seed/organization.json';
import usersSeed from './seed/users.json';
import engagementsSeed from './seed/engagements.json';
import findingsSeed from './seed/findings.json';
import actionPlansSeed from './seed/actionPlans.json';
import workPapersSeed from './seed/workPapers.json';
import risksSeed from './seed/risks.json';
import auditUniverseSeed from './seed/auditUniverse.json';
import notificationsSeed from './seed/notifications.json';
import auditLogSeed from './seed/auditLog.json';
import { atDayOffset, atMinuteOffset } from './date';
import type {
  ActionPlan,
  AuditLogEntry,
  Engagement,
  Finding,
  NotificationItem,
  SandboxState,
  TimelineEvent,
  WorkPaper,
} from './types';

function actionTimeline(plan: ActionPlan): TimelineEvent[] {
  const events: TimelineEvent[] = [
    {
      id: `${plan.actionPlanId}-created`,
      label: 'Action plan created and assigned',
      createdAt: plan.createdAt,
      kind: 'created',
    },
    {
      id: `${plan.actionPlanId}-reminder`,
      label: 'Automatic follow-up reminder scheduled',
      createdAt: plan.reminderDate,
      kind: 'reminder',
    },
  ];

  if (plan.status === 'Overdue') {
    events.push({
      id: `${plan.actionPlanId}-overdue`,
      label: 'Due date passed — automatic escalation recorded',
      createdAt: plan.dueDate,
      kind: 'escalation',
    });
  }

  if (['Pending Verification', 'Verified', 'Closed'].includes(plan.status)) {
    events.push({
      id: `${plan.actionPlanId}-implementation`,
      label: 'Owner submitted implementation evidence',
      createdAt: atDayOffset(Math.min(-1, plan.dueOffsetDays - 1)),
      kind: 'evidence',
    });
  }

  return events.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function createSeedState(now = new Date()): SandboxState {
  const engagements = (engagementsSeed as Array<Record<string, unknown>>).map((raw) => ({
    ...raw,
    startDate: atDayOffset(Number(raw.startOffsetDays ?? 0), now),
    endDate: atDayOffset(Number(raw.endOffsetDays ?? 0), now),
  })) as Engagement[];

  const findings = (findingsSeed as Array<Record<string, unknown>>).map((raw) => ({
    ...raw,
    dueDate: atDayOffset(Number(raw.dueOffsetDays ?? 0), now),
    createdAt: atDayOffset(Number(raw.createdOffsetDays ?? 0), now),
    activity: [
      {
        id: `${raw.id}-raised`,
        label: 'Finding created from work-paper exception',
        createdAt: atDayOffset(Number(raw.createdOffsetDays ?? 0), now),
        kind: 'finding',
      },
      {
        id: `${raw.id}-response`,
        label: 'Management response recorded',
        createdAt: atDayOffset(Number(raw.createdOffsetDays ?? 0) + 3, now),
        kind: 'response',
      },
    ],
  })) as Finding[];

  const actionPlans = (actionPlansSeed as Array<Record<string, unknown>>).map((raw) => {
    const plan = {
      ...raw,
      dueDate: atDayOffset(Number(raw.dueOffsetDays ?? 0), now),
      reminderDate: atDayOffset(Number(raw.reminderOffsetDays ?? 0), now),
      createdAt: atDayOffset(Number(raw.createdOffsetDays ?? 0), now),
      activity: [],
    } as unknown as ActionPlan;
    plan.activity = actionTimeline(plan);
    return plan;
  });

  const workPapers = (workPapersSeed as Array<Record<string, unknown>>).map((raw) => ({
    ...raw,
    workPaperDate: atDayOffset(Number(raw.workPaperDateOffsetDays ?? 0), now),
    auditPeriodFrom: atDayOffset(Number(raw.auditPeriodFromOffsetDays ?? 0), now),
    auditPeriodTo: atDayOffset(Number(raw.auditPeriodToOffsetDays ?? 0), now),
    reviewNotes: (raw.reviewNotes as Array<Record<string, unknown>>).map((note) => ({
      ...note,
      createdAt: atDayOffset(Number(note.offsetDays ?? 0), now),
    })),
    evidence: (raw.evidence as Array<Record<string, unknown>>).map((file) => ({
      ...file,
      uploadedAt: atDayOffset(Number(file.uploadedOffsetDays ?? 0), now),
    })),
  })) as WorkPaper[];

  const notifications = (notificationsSeed as Array<Record<string, unknown>>).map((raw) => ({
    ...raw,
    createdAt: atMinuteOffset(Number(raw.offsetMinutes ?? 0), now),
    read: false,
  })) as NotificationItem[];

  const auditLog = (auditLogSeed as Array<Record<string, unknown>>).map((raw) => ({
    ...raw,
    createdAt: atMinuteOffset(Number(raw.offsetMinutes ?? 0), now),
  })) as AuditLogEntry[];

  return {
    version: 2,
    initializedAt: now.toISOString(),
    organization: organizationSeed as SandboxState['organization'],
    users: usersSeed as SandboxState['users'],
    activeUserId: 'USR-CAE',
    activeRoleCode: 'HEAD_OF_AUDIT',
    activeAffiliateCode: 'HO',
    screen: 'dashboard',
    selectedEngagementId: null,
    selectedFindingId: null,
    selectedWorkPaperId: null,
    engagements,
    findings,
    actionPlans,
    workPapers,
    risks: risksSeed as SandboxState['risks'],
    auditUniverse: auditUniverseSeed as SandboxState['auditUniverse'],
    auditLog,
    notifications,
    savedFindingViews: [
      { id: 'VIEW-HIGH', name: 'High & critical open', filters: { rating: 'High,Critical', status: 'open' } },
      { id: 'VIEW-OVERDUE', name: 'Overdue actions', filters: { overdue: '1' } },
    ],
    findingDraft: {
      step: 1,
      condition: '',
      criteria: '',
      cause: '',
      effect: '',
      riskRating: '',
      recommendation: '',
      engagementId: 'ENG-2026-01',
      process: 'ICT',
    },
    tourDismissed: false,
    undo: null,
  };
}
