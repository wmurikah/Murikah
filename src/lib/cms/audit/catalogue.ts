/**
 * The audit event vocabulary, in one place.
 *
 * Every module that writes an audit row names its own event types, which is
 * right: the writer knows what happened. What was missing is a reader's view
 * of the whole set, and without one the audit workspace would have to guess
 * what an event means from its name, and a filter list would be whatever
 * somebody remembered to add.
 *
 * So this module is the reader's catalogue. It carries, for each event type,
 * a business label, the classification a filter can use, and whether it is
 * high-impact. Section 6 of the phase asks for the high-risk classification
 * to be "an explicit list in one module, not a scattered condition", and the
 * same argument applies to all three facts, so they live together.
 *
 * AN UNKNOWN EVENT TYPE IS NOT AN ERROR. A module added tomorrow will write
 * an event this list has never seen, and the workspace must render it rather
 * than hiding it: an audit trail that silently drops what it does not
 * recognise is worse than useless. `describe` falls back to a readable label
 * derived from the code, classified as business and not high-risk, and
 * `UNCATALOGUED` reports which types are in the database but not here so the
 * gap is visible rather than silent.
 */

/**
 * What kind of event this is, for the filter in section 3.
 *
 * SECURITY covers authentication and access: who signed in, who was granted
 * what, whose access was taken away. CONFIGURATION covers changes to how the
 * system behaves: workflows, SLA rules, roles, the catalogue, the
 * organisation. BUSINESS covers changes to the records the business keeps:
 * customers, leads, orders, cases.
 *
 * The distinction that matters is the first one. Security events are
 * investigative material about people and are gated behind their own
 * permission; the other two are the ordinary record of work.
 */
export type AuditClass = 'SECURITY' | 'CONFIGURATION' | 'BUSINESS';

export interface AuditEventMeta {
  /** What a reader who does not know the schema would call this. */
  readonly label: string;
  readonly classification: AuditClass;
  /**
   * High impact. Not "important": every audit row is important. This marks
   * the events that change what somebody is able to do, or that would be the
   * first step in an attack worth noticing.
   */
  readonly highRisk: boolean;
  /**
   * Why it is high-impact, in one line, shown beside the label. Present only
   * where `highRisk` is true, because an explanation of an ordinary event is
   * noise.
   */
  readonly why?: string;
}

const S = 'SECURITY' as const;
const C = 'CONFIGURATION' as const;
const B = 'BUSINESS' as const;

/**
 * The catalogue. Read from the event types the repository actually writes,
 * module by module, rather than imagined.
 */
export const AUDIT_CATALOGUE: Readonly<Record<string, AuditEventMeta>> = {
  // ---- Authentication -------------------------------------------------------
  LOGIN_SUCCESS: { label: 'Signed in', classification: S, highRisk: false },
  LOGIN_FAILED: { label: 'Sign-in failed', classification: S, highRisk: false },
  LOGIN_LOCKOUT: {
    label: 'Account locked after repeated failures',
    classification: S,
    highRisk: true,
    why: 'Repeated failures against one account are what a credential attack looks like.',
  },
  LOGOUT: { label: 'Signed out', classification: S, highRisk: false },
  MFA_ENROLLED: { label: 'Second factor enrolled', classification: S, highRisk: false },
  MFA_METHOD_CHANGED: {
    label: 'Second factor method changed',
    classification: S,
    highRisk: true,
    why: 'Changing the second factor is how an attacker keeps an account they have taken.',
  },
  MFA_BACKUP_REGENERATED: {
    label: 'Backup codes regenerated',
    classification: S,
    highRisk: true,
    why: 'New backup codes replace every old one, so a stolen set stops working and a new set exists.',
  },
  MFA_BACKUP_USED: { label: 'Backup code used', classification: S, highRisk: false },
  MFA_OTP_SENT: { label: 'One-time code sent', classification: S, highRisk: false },
  MFA_OTP_LOCKED: {
    label: 'One-time code locked after repeated failures',
    classification: S,
    highRisk: true,
    why: 'Repeated failures against a second factor suggest somebody already has the password.',
  },

  // ---- Users, roles, scope --------------------------------------------------
  USER_CREATED: { label: 'User created', classification: S, highRisk: false },
  USER_UPDATED: { label: 'User details changed', classification: C, highRisk: false },
  USER_EMAIL_CHANGED: {
    label: 'User email changed',
    classification: S,
    highRisk: true,
    why: 'The email is the sign-in identity and the address a password reset goes to.',
  },
  USER_SUSPENDED: {
    label: 'User suspended',
    classification: S,
    highRisk: true,
    why: 'Access was taken away, and somebody will ask who did it and when.',
  },
  USER_REACTIVATED: {
    label: 'User reactivated',
    classification: S,
    highRisk: true,
    why: 'Access was given back to an account that had been stopped.',
  },
  USER_ROLE_ASSIGNED: {
    label: 'Access role granted',
    classification: S,
    highRisk: true,
    why: 'A role carries permissions, so this changes what the person can do.',
  },
  USER_ROLE_REMOVED: { label: 'Access role removed', classification: S, highRisk: false },
  ROLE_SCOPE_ASSIGNED: {
    label: 'Data scope granted',
    classification: S,
    highRisk: true,
    why: 'A scope decides whose records the person can see. Group scope means everybody.',
  },
  ROLE_SCOPE_CHANGED: {
    label: 'Data scope changed',
    classification: S,
    highRisk: true,
    why: 'A widened scope is the quiet way to see records that were out of reach.',
  },
  ROLE_CREATED: { label: 'Access role created', classification: C, highRisk: false },
  ROLE_UPDATED: { label: 'Access role changed', classification: C, highRisk: false },
  ROLE_DEACTIVATED: { label: 'Access role deactivated', classification: C, highRisk: false },
  PERMISSION_GRANTED: {
    label: 'Permission granted to role',
    classification: S,
    highRisk: true,
    why: 'This changes what everybody holding that role can do, not one person.',
  },
  PERMISSION_REVOKED: {
    label: 'Permission removed from role',
    classification: S,
    highRisk: true,
    why: 'This removes an ability from everybody holding that role at once.',
  },
  ASSIGNMENT_CREATED: {
    label: 'Organisational assignment created',
    classification: C,
    highRisk: false,
  },
  ASSIGNMENT_UPDATED: {
    label: 'Organisational assignment changed',
    classification: C,
    highRisk: false,
  },

  // ---- Approval authority ---------------------------------------------------
  WORKFLOW_ROLE_CREATED: { label: 'Workflow role created', classification: C, highRisk: false },
  WORKFLOW_ROLE_CHANGED: { label: 'Workflow role changed', classification: C, highRisk: false },
  WORKFLOW_ROLE_ASSIGNED: {
    label: 'Approval authority granted',
    classification: S,
    highRisk: true,
    why: 'This is approval authority, which is not the same as application access.',
  },
  AUTHORITY_RULE_CREATED: {
    label: 'Approval authority rule created',
    classification: C,
    highRisk: true,
    why: 'An authority rule decides which values a person may approve.',
  },
  AUTHORITY_RULE_CHANGED: {
    label: 'Approval authority rule changed',
    classification: C,
    highRisk: true,
    why: 'A widened band lets somebody approve more than they could yesterday.',
  },
  WORKFLOW_CREATED: { label: 'Workflow created', classification: C, highRisk: false },
  WORKFLOW_VERSION_CREATED: {
    label: 'Workflow version created',
    classification: C,
    highRisk: true,
    why: 'A new version changes how every future transaction is approved.',
  },
  WORKFLOW_STAGE_CHANGED: {
    label: 'Workflow stage changed',
    classification: C,
    highRisk: true,
    why: 'Removing or reordering a stage removes or reorders a control.',
  },
  APPROVER_RESOLVED: { label: 'Approver resolved', classification: B, highRisk: false },
  APPROVAL_COMPLETED: { label: 'Approved', classification: B, highRisk: false },
  APPROVAL_REJECTED: { label: 'Rejected', classification: B, highRisk: false },
  APPROVAL_EXCEPTION: {
    label: 'Approval exception',
    classification: B,
    highRisk: true,
    why: 'The normal route was not available, so somebody decided outside it.',
  },

  // ---- SLA and organisation configuration ----------------------------------
  SLA_PROFILE_CREATED: { label: 'SLA profile created', classification: C, highRisk: false },
  SLA_PROFILE_UPDATED: { label: 'SLA profile changed', classification: C, highRisk: false },
  SLA_RULE_CREATED: { label: 'SLA rule created', classification: C, highRisk: false },
  SLA_RULE_UPDATED: {
    label: 'SLA target changed',
    classification: C,
    highRisk: true,
    why: 'Changing a target changes every compliance figure measured against it.',
  },
  CALENDAR_UPDATED: {
    label: 'Business calendar changed',
    classification: C,
    highRisk: true,
    why: 'Working hours and holidays decide what an SLA clock counts.',
  },
  ORGANISATION_CHANGE: {
    label: 'Organisation structure changed',
    classification: C,
    highRisk: false,
  },
  JOB_TITLE_CREATED: { label: 'Job title created', classification: C, highRisk: false },
  JOB_TITLE_UPDATED: { label: 'Job title changed', classification: C, highRisk: false },

  // ---- Portal ---------------------------------------------------------------
  PORTAL_USER_INVITED: {
    label: 'Portal access granted to a contact',
    classification: S,
    highRisk: true,
    why: 'Somebody outside Hass can now sign in and see that customer.',
  },
  PORTAL_USER_ACTIVATED: {
    label: 'Portal membership reinstated',
    classification: S,
    highRisk: true,
    why: 'External access that had been stopped is working again.',
  },
  PORTAL_MEMBERSHIP_SUSPENDED: {
    label: 'Portal membership suspended',
    classification: S,
    highRisk: false,
  },
  PORTAL_MEMBERSHIP_REVOKED: {
    label: 'Portal membership revoked',
    classification: S,
    highRisk: false,
  },

  // ---- Catalogue ------------------------------------------------------------
  PRODUCT_GROUP_CREATED: { label: 'Product group created', classification: C, highRisk: false },
  PRODUCT_GROUP_UPDATED: { label: 'Product group changed', classification: C, highRisk: false },
  PRODUCT_CATEGORY_CREATED: {
    label: 'Product category created',
    classification: C,
    highRisk: false,
  },
  PRODUCT_CATEGORY_UPDATED: {
    label: 'Product category changed',
    classification: C,
    highRisk: false,
  },
  PRODUCT_CREATED: { label: 'Product created', classification: C, highRisk: false },
  PRODUCT_UPDATED: { label: 'Product changed', classification: C, highRisk: false },
  PRODUCT_DEACTIVATED: { label: 'Product deactivated', classification: C, highRisk: false },
  PIPELINE_CREATED: { label: 'Pipeline created', classification: C, highRisk: false },
  PIPELINE_UPDATED: { label: 'Pipeline changed', classification: C, highRisk: false },
  LOST_REASON_CREATED: { label: 'Lost reason created', classification: C, highRisk: false },
  LOST_REASON_UPDATED: { label: 'Lost reason changed', classification: C, highRisk: false },
  LEAD_SOURCE_CREATED: { label: 'Lead source created', classification: C, highRisk: false },
  LEAD_SOURCE_UPDATED: { label: 'Lead source changed', classification: C, highRisk: false },

  // ---- Customers and contacts ----------------------------------------------
  ACCOUNT_CREATED: { label: 'Customer created', classification: B, highRisk: false },
  ACCOUNT_UPDATED: { label: 'Customer changed', classification: B, highRisk: false },
  ACCOUNT_TYPE_CHANGED: { label: 'Customer type changed', classification: B, highRisk: false },
  ACCOUNT_STATUS_CHANGED: { label: 'Customer status changed', classification: B, highRisk: false },
  ACCOUNT_MANAGER_CHANGED: { label: 'Account manager changed', classification: B, highRisk: false },
  CONTACT_CREATED: { label: 'Contact created', classification: B, highRisk: false },
  CONTACT_UPDATED: { label: 'Contact changed', classification: B, highRisk: false },
  CONTACT_DEACTIVATED: { label: 'Contact deactivated', classification: B, highRisk: false },
  PRIMARY_CONTACT_CHANGED: { label: 'Primary contact changed', classification: B, highRisk: false },

  // ---- CRM ------------------------------------------------------------------
  LEAD_CREATED: { label: 'Lead created', classification: B, highRisk: false },
  LEAD_UPDATED: { label: 'Lead changed', classification: B, highRisk: false },
  LEAD_OWNER_CHANGED: { label: 'Lead owner changed', classification: B, highRisk: false },
  LEAD_CONTACTED: { label: 'Lead first contacted', classification: B, highRisk: false },
  LEAD_QUALIFIED: { label: 'Lead qualified', classification: B, highRisk: false },
  LEAD_DISQUALIFIED: { label: 'Lead disqualified', classification: B, highRisk: false },
  LEAD_CONVERTED: { label: 'Lead converted', classification: B, highRisk: false },
  OPPORTUNITY_CREATED: { label: 'Opportunity created', classification: B, highRisk: false },
  OPPORTUNITY_UPDATED: { label: 'Opportunity changed', classification: B, highRisk: false },
  OPPORTUNITY_STAGE_CHANGED: {
    label: 'Opportunity stage changed',
    classification: B,
    highRisk: false,
  },
  OPPORTUNITY_OWNER_CHANGED: {
    label: 'Opportunity owner changed',
    classification: B,
    highRisk: false,
  },
  OPPORTUNITY_WON: { label: 'Opportunity won', classification: B, highRisk: false },
  OPPORTUNITY_LOST: { label: 'Opportunity lost', classification: B, highRisk: false },
  PRODUCT_ADDED: { label: 'Product added to opportunity', classification: B, highRisk: false },
  PRODUCT_REMOVED: {
    label: 'Product removed from opportunity',
    classification: B,
    highRisk: false,
  },

  // ---- Activities and service ----------------------------------------------
  ACTIVITY_CREATED: { label: 'Activity logged', classification: B, highRisk: false },
  ACTIVITY_UPDATED: { label: 'Activity changed', classification: B, highRisk: false },
  ACTIVITY_COMPLETED: { label: 'Activity completed', classification: B, highRisk: false },
  ACTIVITY_REASSIGNED: { label: 'Activity reassigned', classification: B, highRisk: false },
  CASE_CREATED: { label: 'Case raised', classification: B, highRisk: false },
  CASE_UPDATED: { label: 'Case changed', classification: B, highRisk: false },
  CASE_ASSIGNED: { label: 'Case assigned', classification: B, highRisk: false },
  CASE_REASSIGNED: { label: 'Case reassigned', classification: B, highRisk: false },
  CASE_STATUS_CHANGED: { label: 'Case status changed', classification: B, highRisk: false },
  CASE_FIRST_RESPONSE: { label: 'First response sent', classification: B, highRisk: false },
  CASE_COMMUNICATION_ADDED: {
    label: 'Case communication added',
    classification: B,
    highRisk: false,
  },
  CASE_RESOLVED: { label: 'Case resolved', classification: B, highRisk: false },
  CASE_CLOSED: { label: 'Case closed', classification: B, highRisk: false },
  CASE_CANCELLED: { label: 'Case cancelled', classification: B, highRisk: false },

  // ---- Imports --------------------------------------------------------------
  IMPORT_UPLOADED: { label: 'Extract uploaded', classification: B, highRisk: false },
  IMPORT_VALIDATED: { label: 'Extract validated', classification: B, highRisk: false },
  IMPORT_COMMITTED: { label: 'Extract committed', classification: B, highRisk: false },
  IMPORT_PARTIAL: { label: 'Extract partly committed', classification: B, highRisk: false },
  IMPORT_ROW_REPROCESSED: { label: 'Import row reprocessed', classification: B, highRisk: false },
  UNRESOLVED_ACTOR_MAPPED: {
    label: 'Source name mapped to a user',
    classification: S,
    highRisk: true,
    why: 'This decides who the system credits with imported work, including approvals.',
  },
  SOURCE_IDENTITY_MAPPED: {
    label: 'Source identity mapped',
    classification: S,
    highRisk: true,
    why: 'This decides who the system credits with imported work, including approvals.',
  },

  // ---- This phase -----------------------------------------------------------
  AUDIT_EXPORTED: {
    label: 'Audit evidence exported',
    classification: S,
    highRisk: true,
    why: 'Audit content left the controls that protect it, and the export itself is evidence.',
  },
};

/** Turn `CASE_FIRST_RESPONSE` into `Case first response` for an unknown code. */
function derivedLabel(eventType: string): string {
  const words = eventType.toLowerCase().replace(/_/g, ' ').trim();
  return words === '' ? 'Unknown event' : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The meta for an event type, catalogued or not.
 *
 * An uncatalogued type is described, classified as business and treated as
 * ordinary. Guessing that an unrecognised event is high-risk would fill the
 * high-risk view with noise the first time a module added a routine event;
 * guessing it is security would hide business events behind a permission.
 * Business and not-high-risk is the reading that neither hides nor alarms.
 */
export function describe(eventType: string): AuditEventMeta {
  return (
    AUDIT_CATALOGUE[eventType] ?? {
      label: derivedLabel(eventType),
      classification: 'BUSINESS',
      highRisk: false,
    }
  );
}

export function isHighRisk(eventType: string): boolean {
  return describe(eventType).highRisk;
}

export function classify(eventType: string): AuditClass {
  return describe(eventType).classification;
}

/** Every catalogued type in one class, for the filter's option list. */
export function typesInClass(classification: AuditClass): string[] {
  return Object.entries(AUDIT_CATALOGUE)
    .filter(([, meta]) => meta.classification === classification)
    .map(([code]) => code)
    .sort();
}

export const SECURITY_EVENT_TYPES: readonly string[] = typesInClass('SECURITY');
export const HIGH_RISK_EVENT_TYPES: readonly string[] = Object.entries(AUDIT_CATALOGUE)
  .filter(([, meta]) => meta.highRisk)
  .map(([code]) => code)
  .sort();
