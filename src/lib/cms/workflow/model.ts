/**
 * The vocabulary of workflow authority, taken from the schema's own CHECK
 * constraints rather than invented here.
 *
 * Every list below is a transcription of a constraint in
 * hass_cms_turso_v1_FINAL.sql. They are written down once so a validator, a
 * form and a test all reject the same values, and so a value the database would
 * refuse is refused earlier, with a field message, instead of arriving as a
 * CHECK failure with no field attached.
 *
 * TWO PROCESS LISTS, AND THEY ARE NOT THE SAME
 * `workflow_roles.process_type` permits LEAD, OPPORTUNITY and CASE.
 * `approval_authority_rules.process_type` does not. That asymmetry is in the
 * schema, it is not a mistake to correct, and it decides how the resolver
 * treats a lead, an opportunity or a case: see AUTHORITY_PROCESS_TYPES below
 * and the note in ./resolver.ts.
 */

/** `workflow_roles.process_type` and `workflow_definitions.process_type`. */
export const PROCESS_TYPES = [
  'LEAD',
  'OPPORTUNITY',
  'CASE',
  'SALES_ORDER',
  'PURCHASE_ORDER',
  'CREDIT_EXCEPTION',
  'OTHER',
] as const;
export type ProcessType = (typeof PROCESS_TYPES)[number];

/**
 * `approval_authority_rules.process_type`. Four values, not seven.
 *
 * A rule therefore cannot restrict a lead, an opportunity or a case by amount,
 * currency or product. The resolver's answer to that is stated in ./resolver.ts
 * and is not "map it onto OTHER".
 */
export const AUTHORITY_PROCESS_TYPES = [
  'SALES_ORDER',
  'PURCHASE_ORDER',
  'CREDIT_EXCEPTION',
  'OTHER',
] as const;
export type AuthorityProcessType = (typeof AUTHORITY_PROCESS_TYPES)[number];

export function carriesAuthorityRules(process: ProcessType): process is AuthorityProcessType {
  return (AUTHORITY_PROCESS_TYPES as readonly string[]).includes(process);
}

/**
 * `workflow_role_assignments.scope_type`.
 *
 * Four values. There is no TEAM and no OWN here, unlike `user_role_scopes`,
 * which is why this list exists separately from SCOPE_TYPES in ../auth/rbac.ts
 * rather than being reused from it. Reusing that one would let a validator
 * accept a TEAM scope the database then refuses.
 */
export const WORKFLOW_SCOPE_TYPES = ['BUSINESS_UNIT', 'AFFILIATE', 'COUNTRY', 'GROUP'] as const;
export type WorkflowScopeType = (typeof WORKFLOW_SCOPE_TYPES)[number];

/**
 * Specificity order, most specific first. Section 7's ladder.
 *
 * The index is the tier: the resolver takes the lowest tier that produced any
 * eligible approver and stops. That is what stops a group assignment silently
 * replacing a valid local approver, and it needs no special case for the group
 * role, because a workflow role whose only assignments are GROUP-scoped reaches
 * the group tier by having nothing above it.
 */
export const SCOPE_SPECIFICITY: readonly WorkflowScopeType[] = [
  'BUSINESS_UNIT',
  'AFFILIATE',
  'COUNTRY',
  'GROUP',
];

export function specificityTier(scope: WorkflowScopeType): number {
  const index = SCOPE_SPECIFICITY.indexOf(scope);
  return index === -1 ? SCOPE_SPECIFICITY.length : index;
}

/** `workflow_stages.assignment_type`. */
export const ASSIGNMENT_TYPES = ['USER', 'WORKFLOW_ROLE', 'TEAM', 'SYSTEM'] as const;
export type AssignmentType = (typeof ASSIGNMENT_TYPES)[number];

/** `workflow_stages.approval_mode`. All six are implemented; see ./runtime. */
export const APPROVAL_MODES = [
  'ANY_ONE',
  'ALL',
  'SEQUENTIAL',
  'ROUND_ROBIN',
  'NAMED',
  'SYSTEM',
] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** `workflow_stage_instances.status` and `workflow_stage_assignees.status`. */
export const STAGE_STATUSES = [
  'PENDING',
  'ACTIVE',
  'APPROVED',
  'REJECTED',
  'SKIPPED',
  'COMPLETED',
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/** `workflow_instances.status`. */
export const INSTANCE_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

/**
 * The audit event types this phase writes, named once.
 *
 * `workflow_events` is not among them, and is not created: it is not one of the
 * 72 tables in the schema. Workflow auditing goes to `audit_events` through the
 * Build Prompt 03 writer, like every other change in this product.
 */
export const WORKFLOW_AUDIT = {
  roleCreated: 'WORKFLOW_ROLE_CREATED',
  roleChanged: 'WORKFLOW_ROLE_CHANGED',
  roleAssigned: 'WORKFLOW_ROLE_ASSIGNED',
  ruleCreated: 'AUTHORITY_RULE_CREATED',
  ruleChanged: 'AUTHORITY_RULE_CHANGED',
  workflowCreated: 'WORKFLOW_CREATED',
  versionCreated: 'WORKFLOW_VERSION_CREATED',
  stageChanged: 'WORKFLOW_STAGE_CHANGED',
  /** Written when a stage instance is assigned. Never on a preview. */
  approverResolved: 'APPROVER_RESOLVED',
  approvalCompleted: 'APPROVAL_COMPLETED',
  approvalRejected: 'APPROVAL_REJECTED',
  /** No eligible approver. Nobody is assigned and the stage stays visible. */
  approvalException: 'APPROVAL_EXCEPTION',
} as const;

/** A calendar day as the schema stores dates: YYYY-MM-DD, no time, no zone. */
export function isoDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}
