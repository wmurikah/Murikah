/**
 * The notification catalogue, ported from the source NOTIFICATION_TYPES. Each
 * type carries its priority (urgent items are sent promptly, normal items are
 * batched into a per-recipient digest), the in-app severity, whether it copies
 * the Head of Audit, and the entity it concerns. Import-free (types and data
 * only), so node strips types and unit-tests this directly.
 */

export type NotificationType =
  | 'WP_ASSIGNMENT'
  | 'WP_SUBMITTED'
  | 'WP_REVIEW_REQUEST'
  | 'WP_APPROVED'
  | 'WP_REVISION_REQUIRED'
  | 'WP_SENT_TO_AUDITEE'
  | 'WP_STATUS_CHANGE'
  | 'RESPONSE_SUBMITTED'
  | 'RESPONSE_REVIEWED'
  | 'AP_ASSIGNED'
  | 'AP_DELEGATED'
  | 'AP_DELEGATION_RESPONSE'
  | 'AP_IMPLEMENTED'
  | 'AP_VERIFIED'
  | 'AP_HOA_REVIEWED'
  | 'AP_OVERDUE'
  | 'STALE_REMINDER'
  | 'OVERDUE_REMINDER'
  | 'DUE_SOON_REMINDER'
  | 'REQUIREMENT_ASSIGNED'
  | 'REQUIREMENT_SUBMITTED'
  | 'REQUIREMENT_MORE_INFO'
  | 'PASSWORD_RESET';

export type Priority = 'normal' | 'urgent';
export type Severity = 'info' | 'warning' | 'urgent';
export type EntityType = 'work_paper' | 'action_plan' | 'requirement' | 'user';

export interface TypeMeta {
  label: string;
  priority: Priority;
  severity: Severity;
  /** Copies all SUPER_ADMIN users (the Head of Audit) on this event. */
  ccHoa: boolean;
  entity: EntityType;
}

export const TYPE_META: Record<NotificationType, TypeMeta> = {
  WP_ASSIGNMENT: {
    label: 'Work paper assigned',
    priority: 'normal',
    severity: 'info',
    ccHoa: false,
    entity: 'work_paper',
  },
  WP_SUBMITTED: {
    label: 'Work paper submitted',
    priority: 'normal',
    severity: 'info',
    ccHoa: true,
    entity: 'work_paper',
  },
  WP_REVIEW_REQUEST: {
    label: 'Review requested',
    priority: 'normal',
    severity: 'info',
    ccHoa: false,
    entity: 'work_paper',
  },
  WP_APPROVED: {
    label: 'Work paper approved',
    priority: 'normal',
    severity: 'info',
    ccHoa: true,
    entity: 'work_paper',
  },
  WP_REVISION_REQUIRED: {
    label: 'Revision required',
    priority: 'normal',
    severity: 'warning',
    ccHoa: false,
    entity: 'work_paper',
  },
  WP_SENT_TO_AUDITEE: {
    label: 'Finding sent to auditee',
    priority: 'urgent',
    severity: 'urgent',
    ccHoa: true,
    entity: 'work_paper',
  },
  WP_STATUS_CHANGE: {
    label: 'Work paper status changed',
    priority: 'normal',
    severity: 'info',
    ccHoa: false,
    entity: 'work_paper',
  },
  RESPONSE_SUBMITTED: {
    label: 'Response submitted',
    priority: 'normal',
    severity: 'info',
    ccHoa: true,
    entity: 'work_paper',
  },
  RESPONSE_REVIEWED: {
    label: 'Response reviewed',
    priority: 'normal',
    severity: 'info',
    ccHoa: true,
    entity: 'work_paper',
  },
  AP_ASSIGNED: {
    label: 'Action plan assigned',
    priority: 'normal',
    severity: 'info',
    ccHoa: false,
    entity: 'action_plan',
  },
  AP_DELEGATED: {
    label: 'Action plan delegated',
    priority: 'normal',
    severity: 'info',
    ccHoa: false,
    entity: 'action_plan',
  },
  AP_DELEGATION_RESPONSE: {
    label: 'Delegation decision',
    priority: 'normal',
    severity: 'info',
    ccHoa: false,
    entity: 'action_plan',
  },
  AP_IMPLEMENTED: {
    label: 'Action plan implemented',
    priority: 'normal',
    severity: 'info',
    ccHoa: false,
    entity: 'action_plan',
  },
  AP_VERIFIED: {
    label: 'Action plan verified',
    priority: 'normal',
    severity: 'info',
    ccHoa: false,
    entity: 'action_plan',
  },
  AP_HOA_REVIEWED: {
    label: 'Head of Audit review',
    priority: 'normal',
    severity: 'warning',
    ccHoa: false,
    entity: 'action_plan',
  },
  AP_OVERDUE: {
    label: 'Action plan overdue',
    priority: 'urgent',
    severity: 'warning',
    ccHoa: true,
    entity: 'action_plan',
  },
  STALE_REMINDER: {
    label: 'Draft reminder',
    priority: 'normal',
    severity: 'warning',
    ccHoa: true,
    entity: 'work_paper',
  },
  OVERDUE_REMINDER: {
    label: 'Overdue reminder',
    priority: 'urgent',
    severity: 'warning',
    ccHoa: false,
    entity: 'action_plan',
  },
  DUE_SOON_REMINDER: {
    label: 'Deadline approaching',
    priority: 'normal',
    severity: 'warning',
    ccHoa: false,
    entity: 'action_plan',
  },
  // The requirements loop (Build Prompt 58). An owner being asked for something,
  // and being asked again, are the events they act on, so both copy the head of
  // audit for nothing: they are between the auditor and the owner. A submission
  // is the auditor's cue to review, and it is batched like every other normal
  // item, so twelve owners answering on a Friday make one digest.
  REQUIREMENT_ASSIGNED: {
    label: 'Information requested',
    priority: 'normal',
    severity: 'info',
    ccHoa: false,
    entity: 'requirement',
  },
  REQUIREMENT_SUBMITTED: {
    label: 'Information provided',
    priority: 'normal',
    severity: 'info',
    ccHoa: false,
    entity: 'requirement',
  },
  REQUIREMENT_MORE_INFO: {
    label: 'Further information requested',
    priority: 'normal',
    severity: 'warning',
    ccHoa: false,
    entity: 'requirement',
  },
  PASSWORD_RESET: {
    label: 'Password reset link',
    priority: 'urgent',
    severity: 'info',
    ccHoa: false,
    entity: 'user',
  },
};

export const NOTIFICATION_TYPES = Object.keys(TYPE_META) as NotificationType[];

export function isNotificationType(v: string): v is NotificationType {
  return Object.prototype.hasOwnProperty.call(TYPE_META, v);
}

export function priorityOf(type: NotificationType): Priority {
  return TYPE_META[type].priority;
}
export function severityOf(type: NotificationType): Severity {
  return TYPE_META[type].severity;
}
export function ccsHoa(type: NotificationType): boolean {
  return TYPE_META[type].ccHoa;
}
export function entityOf(type: NotificationType): EntityType {
  return TYPE_META[type].entity;
}
