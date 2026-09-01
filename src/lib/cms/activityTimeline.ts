/**
 * One mapping from an activity row to its timeline entry, for two renderers.
 *
 * The server draws the timeline when the page renders; the browser inserts
 * one more entry when the composer records an activity, from the SAME
 * function over the SAME canonical row the API returned. Two copies of "how
 * an activity reads" would disagree within a month — the verb here, the due
 * line there — and the newest entry is exactly the one a person is looking
 * at when they compare.
 *
 * Pure over its inputs: no DOM, no dates computed here beyond reshaping the
 * stamps the row already carries, so both runtimes and the tests call it the
 * same way.
 */

/** The verbs the timeline uses. Recorded, never sent: nothing here sends. */
export const ACTIVITY_VERB: Record<string, string> = {
  CALL: 'Recorded call',
  EMAIL: 'Recorded email interaction',
  WHATSAPP: 'Recorded WhatsApp interaction',
  MEETING: 'Meeting',
  VISIT: 'Site visit',
  QUOTATION: 'Quotation recorded',
  PROPOSAL: 'Proposal recorded',
  FOLLOW_UP: 'Follow-up',
  NOTE: 'Note',
  TASK: 'Task',
  OTHER: 'Activity',
};

/**
 * What a type is CALLED in a control, keyed by the canonical token the API
 * speaks. Only the names title-casing would misspell are listed; everything
 * else derives, so a new canonical type can never be missing a label and no
 * second catalogue exists to drift from ACTIVITY_TYPES.
 */
const DISPLAY: Record<string, string> = {
  WHATSAPP: 'WhatsApp',
  VISIT: 'Site visit',
  FOLLOW_UP: 'Follow-up',
};

export function activityTypeLabel(type: string): string {
  return DISPLAY[type] ?? type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ');
}

/** The fields the mapping reads — the shape ActivityRow already satisfies. */
export interface ActivityTimelineSource {
  entityType: string;
  entityId: string;
  activityType: string;
  summary: string;
  contactName: string | null;
  outcome: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  scheduledAt: string | null;
  completedAt: string | null;
  createdAt: string;
  /** COALESCE(next_action_due, scheduled_at) — the repo's one due-time rule. */
  dueAt: string | null;
  ownerName: string;
}

export interface ActivityTimelineEntry {
  title: string;
  /** Empty when there is nothing beyond the title; the renderer omits it. */
  detail: string;
  actor: string;
  /** ISO 8601, for the <time datetime> attribute. */
  timestamp: string;
  timeLabel: string;
  tone: 'default' | 'warning';
}

export function activityTimelineEntry(
  a: ActivityTimelineSource,
  isAccountTimeline: boolean,
): ActivityTimelineEntry {
  const when = a.completedAt ?? a.scheduledAt ?? a.createdAt;
  return {
    title: `${ACTIVITY_VERB[a.activityType] ?? a.activityType}: ${a.summary}`,
    detail: [
      a.contactName === null ? null : `With ${a.contactName}`,
      a.outcome === null ? null : `Outcome: ${a.outcome}`,
      a.nextAction === null
        ? null
        : `Next: ${a.nextAction}${a.nextActionDue === null ? '' : ` by ${a.nextActionDue}`}`,
      a.completedAt === null && a.dueAt !== null ? `Due ${a.dueAt}` : null,
      isAccountTimeline && a.entityType !== 'ACCOUNT'
        ? `On ${a.entityType.toLowerCase().replace('_', ' ')} ${a.entityId}`
        : null,
    ]
      .filter((line): line is string => line !== null)
      .join(' · '),
    actor: a.ownerName,
    timestamp: when.replace(' ', 'T'),
    timeLabel: when,
    // An open item — a scheduled visit, an undone task — is marked so it
    // reads as pending rather than history.
    tone: a.completedAt !== null ? 'default' : 'warning',
  };
}
