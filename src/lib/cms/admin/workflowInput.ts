/**
 * Input validation for workflow authority configuration and for the resolver's
 * two request-shaped endpoints, the approval preview and the decision.
 *
 * The same `FieldError` shape and the same `Validated<T>` union as every other
 * form in this product.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * There is no `userId` in `validateDecision`, and no `actorUserId` anywhere.
 * The acting principal comes from the session, so a payload cannot name one:
 * the field is not read, so sending it changes nothing. That is the same
 * defence rbacInput.ts uses for `isSystemRole`, and it is stronger than
 * rejecting the field, because rejecting it means somebody has to remember to.
 *
 * Every value is checked against the schema's own CHECK constraint through
 * ../workflow/model.ts, so a value the database would refuse gets a field
 * message here rather than a constraint failure with nothing to attach it to.
 */
import type { FieldError } from '../../validation.ts';
import {
  APPROVAL_MODES,
  ASSIGNMENT_TYPES,
  AUTHORITY_PROCESS_TYPES,
  PROCESS_TYPES,
  WORKFLOW_SCOPE_TYPES,
  type ApprovalMode,
  type AssignmentType,
  type ProcessType,
  type WorkflowScopeType,
} from '../workflow/model.ts';
import type {
  AssignmentInput,
  AuthorityRuleInput,
  DefinitionInput,
  StageInput,
  WorkflowRoleInput,
} from '../repos/workflowAdmin.ts';
import type { TransactionContext } from '../workflow/runtime.ts';
import type { TransactionLine } from '../workflow/resolver.ts';

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const clamp = (v: string, max: number): string => (v.length > max ? v.slice(0, max) : v);
const optional = (v: unknown): string | null => (str(v) === '' ? null : str(v));
const bool = (v: unknown): boolean =>
  v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const body = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A number, or null.
 *
 * An empty string is null, not zero. On an amount bound that distinction is the
 * whole meaning: null is "no lower bound" and zero is "at least nothing", and
 * the two read identically in a text input that the administrator cleared.
 */
function number(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const raw = str(v);
  if (raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(v: unknown, fallback: number): number {
  const parsed = number(v);
  if (parsed === null) return fallback;
  return Math.trunc(parsed);
}

const oneOf = <T extends string>(list: readonly T[], value: string): T | null =>
  (list as readonly string[]).includes(value) ? (value as T) : null;

// ---- workflow roles --------------------------------------------------------

export function validateWorkflowRole(raw: unknown): Validated<WorkflowRoleInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const roleCode = str(input.roleCode).toUpperCase().replace(/\s+/g, '_');
  const roleName = str(input.roleName);
  const rawProcess = str(input.processType).toUpperCase();

  if (roleCode.length < 2) errors.push({ field: 'roleCode', message: 'Enter the role code.' });
  if (roleName.length < 2) errors.push({ field: 'roleName', message: 'Enter the role name.' });

  // An empty process type is a real value: a role that spans every process.
  // That is how the seeded Country Manager and Group Finance roles are written,
  // so an empty field must not be an error.
  const processType = rawProcess === '' ? null : oneOf(PROCESS_TYPES, rawProcess);
  if (rawProcess !== '' && processType === null) {
    errors.push({ field: 'processType', message: 'Choose a process type or leave it empty.' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      roleCode: clamp(roleCode, 60),
      roleName: clamp(roleName, 120),
      processType,
      description: optional(input.description),
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

// ---- assignments -----------------------------------------------------------

export function validateAssignment(
  raw: unknown,
  workflowRoleId: string,
  today: string,
): Validated<AssignmentInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const userId = str(input.userId);
  const scopeType = oneOf(WORKFLOW_SCOPE_TYPES, str(input.scopeType).toUpperCase());
  const effectiveFrom = str(input.effectiveFrom) === '' ? today : str(input.effectiveFrom);
  const effectiveTo = optional(input.effectiveTo);
  const priority = integer(input.priority, 100);

  if (userId === '') errors.push({ field: 'userId', message: 'Choose a person.' });
  if (scopeType === null) errors.push({ field: 'scopeType', message: 'Choose a scope.' });
  if (priority < 0) errors.push({ field: 'priority', message: 'Priority cannot be negative.' });
  if (!ISO_DATE.test(effectiveFrom)) {
    errors.push({ field: 'effectiveFrom', message: 'Enter a date as YYYY-MM-DD.' });
  }
  if (effectiveTo !== null && !ISO_DATE.test(effectiveTo)) {
    errors.push({ field: 'effectiveTo', message: 'Enter a date as YYYY-MM-DD.' });
  }
  if (effectiveTo !== null && ISO_DATE.test(effectiveFrom) && effectiveTo < effectiveFrom) {
    errors.push({ field: 'effectiveTo', message: 'The end date cannot be before the start date.' });
  }

  // The scope's own target must be present. The table's CHECK enforces this
  // too, and it says so with a constraint name; saying it here names the field
  // the administrator has to fill in.
  const countryId = optional(input.countryId);
  const affiliateId = optional(input.affiliateId);
  const businessUnitId = optional(input.businessUnitId);
  if (scopeType === 'COUNTRY' && countryId === null) {
    errors.push({ field: 'countryId', message: 'Choose the country this covers.' });
  }
  if (scopeType === 'AFFILIATE' && affiliateId === null) {
    errors.push({ field: 'affiliateId', message: 'Choose the affiliate this covers.' });
  }
  if (scopeType === 'BUSINESS_UNIT' && businessUnitId === null) {
    errors.push({ field: 'businessUnitId', message: 'Choose the business unit this covers.' });
  }

  if (errors.length > 0 || scopeType === null) {
    return { ok: false, errors: errors.length > 0 ? errors : [] };
  }
  return {
    ok: true,
    value: {
      workflowRoleId,
      userId,
      scopeType: scopeType as WorkflowScopeType,
      countryId,
      affiliateId,
      businessUnitId,
      priority,
      effectiveFrom,
      effectiveTo,
      active: input.active === undefined ? true : bool(input.active),
    },
  };
}

export interface SupersedeInput {
  effectiveTo: string | null;
  active: boolean;
}

export function validateSupersede(raw: unknown): Validated<SupersedeInput> {
  const input = body(raw);
  const effectiveTo = optional(input.effectiveTo);
  if (effectiveTo !== null && !ISO_DATE.test(effectiveTo)) {
    return {
      ok: false,
      errors: [{ field: 'effectiveTo', message: 'Enter a date as YYYY-MM-DD.' }],
    };
  }
  return {
    ok: true,
    value: { effectiveTo, active: input.active === undefined ? false : bool(input.active) },
  };
}

// ---- authority rules -------------------------------------------------------

export function validateAuthorityRule(
  raw: unknown,
  assignmentId: string,
  today: string,
): Validated<AuthorityRuleInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const processType = oneOf(AUTHORITY_PROCESS_TYPES, str(input.processType).toUpperCase());
  if (processType === null) {
    errors.push({
      field: 'processType',
      message: 'Choose a process type. Leads, opportunities and cases cannot carry a rule.',
    });
  }

  const minAmount = number(input.minAmount);
  const maxAmount = number(input.maxAmount);
  if (minAmount !== null && minAmount < 0) {
    errors.push({ field: 'minAmount', message: 'The minimum cannot be negative.' });
  }
  if (maxAmount !== null && maxAmount < 0) {
    errors.push({ field: 'maxAmount', message: 'The maximum cannot be negative.' });
  }
  if (minAmount !== null && maxAmount !== null && maxAmount < minAmount) {
    errors.push({ field: 'maxAmount', message: 'The maximum cannot be below the minimum.' });
  }

  const currency = optional(input.currencyCode);
  if (currency !== null && !/^[A-Za-z]{3}$/.test(currency)) {
    errors.push({ field: 'currencyCode', message: 'Use a three-letter code, or leave it empty.' });
  }

  const effectiveFrom = str(input.effectiveFrom) === '' ? today : str(input.effectiveFrom);
  const effectiveTo = optional(input.effectiveTo);
  if (!ISO_DATE.test(effectiveFrom)) {
    errors.push({ field: 'effectiveFrom', message: 'Enter a date as YYYY-MM-DD.' });
  }
  if (effectiveTo !== null && !ISO_DATE.test(effectiveTo)) {
    errors.push({ field: 'effectiveTo', message: 'Enter a date as YYYY-MM-DD.' });
  }
  if (effectiveTo !== null && ISO_DATE.test(effectiveFrom) && effectiveTo < effectiveFrom) {
    errors.push({ field: 'effectiveTo', message: 'The end date cannot be before the start date.' });
  }

  const rulePriority = integer(input.rulePriority, 100);
  if (rulePriority < 0) {
    errors.push({ field: 'rulePriority', message: 'Priority cannot be negative.' });
  }

  if (errors.length > 0 || processType === null) return { ok: false, errors };
  return {
    ok: true,
    value: {
      assignmentId,
      processType,
      currencyCode: currency === null ? null : currency.toUpperCase(),
      minAmount,
      maxAmount,
      productGroupId: optional(input.productGroupId),
      productCategoryId: optional(input.productCategoryId),
      rulePriority,
      active: input.active === undefined ? true : bool(input.active),
      effectiveFrom,
      effectiveTo,
    },
  };
}

// ---- definitions and stages ------------------------------------------------

export function validateDefinition(raw: unknown, today: string): Validated<DefinitionInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const workflowName = str(input.workflowName);
  const processType = oneOf(PROCESS_TYPES, str(input.processType).toUpperCase());
  const effectiveFrom = str(input.effectiveFrom) === '' ? today : str(input.effectiveFrom);
  const effectiveTo = optional(input.effectiveTo);

  if (workflowName.length < 2) {
    errors.push({ field: 'workflowName', message: 'Enter the workflow name.' });
  }
  if (processType === null) {
    errors.push({ field: 'processType', message: 'Choose a process type.' });
  }
  if (!ISO_DATE.test(effectiveFrom)) {
    errors.push({ field: 'effectiveFrom', message: 'Enter a date as YYYY-MM-DD.' });
  }
  if (effectiveTo !== null && !ISO_DATE.test(effectiveTo)) {
    errors.push({ field: 'effectiveTo', message: 'Enter a date as YYYY-MM-DD.' });
  }

  if (errors.length > 0 || processType === null) return { ok: false, errors };
  return {
    ok: true,
    value: {
      workflowName: clamp(workflowName, 160),
      processType: processType as ProcessType,
      countryId: optional(input.countryId),
      affiliateId: optional(input.affiliateId),
      businessUnitId: optional(input.businessUnitId),
      active: input.active === undefined ? true : bool(input.active),
      effectiveFrom,
      effectiveTo,
    },
  };
}

export interface NewVersionInput {
  effectiveFrom: string;
  retirePrevious: boolean;
}

export function validateNewVersion(raw: unknown, today: string): Validated<NewVersionInput> {
  const input = body(raw);
  const effectiveFrom = str(input.effectiveFrom) === '' ? today : str(input.effectiveFrom);
  if (!ISO_DATE.test(effectiveFrom)) {
    return {
      ok: false,
      errors: [{ field: 'effectiveFrom', message: 'Enter a date as YYYY-MM-DD.' }],
    };
  }
  return {
    ok: true,
    value: {
      effectiveFrom,
      retirePrevious: input.retirePrevious === undefined ? true : bool(input.retirePrevious),
    },
  };
}

export function validateStage(raw: unknown): Validated<StageInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const stageCode = str(input.stageCode).toUpperCase().replace(/\s+/g, '_');
  const stageName = str(input.stageName);
  const sequenceNo = integer(input.sequenceNo, 0);
  const assignmentType = oneOf(ASSIGNMENT_TYPES, str(input.assignmentType).toUpperCase());
  const approvalMode = oneOf(APPROVAL_MODES, str(input.approvalMode).toUpperCase());
  const requiredApprovals = integer(input.requiredApprovals, 1);

  if (stageCode.length < 2) errors.push({ field: 'stageCode', message: 'Enter the stage code.' });
  if (stageName.length < 2) errors.push({ field: 'stageName', message: 'Enter the stage name.' });
  if (sequenceNo < 1) {
    errors.push({ field: 'sequenceNo', message: 'The position must be 1 or more.' });
  }
  if (assignmentType === null) {
    errors.push({ field: 'assignmentType', message: 'Choose how this stage is assigned.' });
  }
  if (approvalMode === null) {
    errors.push({ field: 'approvalMode', message: 'Choose an approval mode.' });
  }
  if (requiredApprovals < 0) {
    errors.push({ field: 'requiredApprovals', message: 'This cannot be negative.' });
  }

  const assignedUserId = optional(input.assignedUserId);
  const assignedWorkflowRoleId = optional(input.assignedWorkflowRoleId);
  const assignedTeamId = optional(input.assignedTeamId);

  if (assignmentType === 'USER' && assignedUserId === null) {
    errors.push({ field: 'assignedUserId', message: 'Choose the person this stage goes to.' });
  }
  if (assignmentType === 'WORKFLOW_ROLE' && assignedWorkflowRoleId === null) {
    errors.push({
      field: 'assignedWorkflowRoleId',
      message: 'Choose the workflow role this stage resolves against.',
    });
  }
  if (assignmentType === 'TEAM' && assignedTeamId === null) {
    errors.push({ field: 'assignedTeamId', message: 'Choose the team this stage goes to.' });
  }
  // SYSTEM is the one mode with no human approver, so pairing it with a human
  // assignment type is a configuration that cannot mean anything. Caught here
  // rather than at run time, where it would look like a stage nobody can act on.
  if (approvalMode === 'SYSTEM' && assignmentType !== 'SYSTEM') {
    errors.push({
      field: 'approvalMode',
      message: 'A system approval mode needs a system assignment type.',
    });
  }
  if (assignmentType === 'SYSTEM' && approvalMode !== 'SYSTEM') {
    errors.push({
      field: 'approvalMode',
      message: 'A system stage has no human approver, so choose the system approval mode.',
    });
  }

  if (errors.length > 0 || assignmentType === null || approvalMode === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      stageCode: clamp(stageCode, 60),
      stageName: clamp(stageName, 160),
      sequenceNo,
      assignmentType: assignmentType as AssignmentType,
      assignedUserId,
      assignedWorkflowRoleId,
      assignedTeamId,
      approvalMode: approvalMode as ApprovalMode,
      requiredApprovals,
      slaRuleId: optional(input.slaRuleId),
      terminalStage: bool(input.terminalStage),
    },
  };
}

export interface ReorderInput {
  order: { stageId: string; sequenceNo: number }[];
}

export function validateReorder(raw: unknown): Validated<ReorderInput> {
  const input = body(raw);
  const list = Array.isArray(input.order) ? input.order : null;
  if (list === null || list.length === 0) {
    return { ok: false, errors: [{ field: 'order', message: 'Send the new stage order.' }] };
  }
  const order: { stageId: string; sequenceNo: number }[] = [];
  const seen = new Set<number>();
  for (const entry of list) {
    const item = body(entry);
    const stageId = str(item.stageId);
    const sequenceNo = integer(item.sequenceNo, 0);
    if (stageId === '' || sequenceNo < 1) {
      return { ok: false, errors: [{ field: 'order', message: 'Every stage needs a position.' }] };
    }
    if (seen.has(sequenceNo)) {
      return {
        ok: false,
        errors: [{ field: 'order', message: 'Two stages were given the same position.' }],
      };
    }
    seen.add(sequenceNo);
    order.push({ stageId, sequenceNo });
  }
  return { ok: true, value: { order } };
}

// ---- the resolver's request shapes -----------------------------------------

function validateLines(raw: unknown): TransactionLine[] {
  const list = Array.isArray(raw) ? raw : [];
  const lines: TransactionLine[] = [];
  for (const entry of list) {
    const item = body(entry);
    lines.push({
      productId: optional(item.productId),
      productCategoryId: optional(item.productCategoryId),
      productGroupId: optional(item.productGroupId),
      lineValue: number(item.lineValue),
    });
  }
  return lines;
}

export interface PreviewInput {
  context: TransactionContext;
  /** Optional: preview one definition rather than letting applicability pick. */
  workflowDefinitionId: string | null;
}

export function validatePreview(raw: unknown, today: string): Validated<PreviewInput> {
  const input = body(raw);
  const errors: FieldError[] = [];

  const processType = oneOf(PROCESS_TYPES, str(input.processType).toUpperCase());
  if (processType === null) errors.push({ field: 'processType', message: 'Choose a process.' });

  const eventDate = str(input.eventDate) === '' ? today : str(input.eventDate);
  if (!ISO_DATE.test(eventDate)) {
    errors.push({ field: 'eventDate', message: 'Enter a date as YYYY-MM-DD.' });
  }

  const currencyCode = optional(input.currencyCode);
  if (currencyCode !== null && !/^[A-Za-z]{3}$/.test(currencyCode)) {
    errors.push({ field: 'currencyCode', message: 'Use a three-letter code, or leave it empty.' });
  }

  const amount = number(input.amount);
  if (amount !== null && amount < 0) {
    errors.push({ field: 'amount', message: 'The amount cannot be negative.' });
  }

  if (errors.length > 0 || processType === null) return { ok: false, errors };
  return {
    ok: true,
    value: {
      workflowDefinitionId: optional(input.workflowDefinitionId),
      context: {
        processType: processType as ProcessType,
        countryId: optional(input.countryId),
        affiliateId: optional(input.affiliateId),
        businessUnitId: optional(input.businessUnitId),
        amount,
        currencyCode: currencyCode === null ? null : currencyCode.toUpperCase(),
        lines: validateLines(input.lines),
        eventDate,
      },
    },
  };
}

export interface DecisionInput {
  decision: 'APPROVED' | 'REJECTED';
  notes: string | null;
}

/**
 * A decision, with no approver in it.
 *
 * `userId`, `approverId`, `actorUserId` and anything else naming a person are
 * not read. The person acting is the session, resolved server side by the
 * endpoint, so a request that names somebody else is answered as if it had not.
 */
export function validateDecision(raw: unknown): Validated<DecisionInput> {
  const input = body(raw);
  const decision = str(input.decision).toUpperCase();
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    return {
      ok: false,
      errors: [{ field: 'decision', message: 'Choose to approve or to reject.' }],
    };
  }
  const notes = optional(input.notes);
  return {
    ok: true,
    value: { decision, notes: notes === null ? null : clamp(notes, 2000) },
  };
}

export interface StartWorkflowInput {
  workflowDefinitionId: string | null;
  entityType: string;
  entityId: string;
  context: TransactionContext;
}

export function validateStartWorkflow(raw: unknown, today: string): Validated<StartWorkflowInput> {
  const preview = validatePreview(raw, today);
  if (!preview.ok) return preview;
  const input = body(raw);
  const entityType = str(input.entityType).toUpperCase();
  const entityId = str(input.entityId);
  const errors: FieldError[] = [];
  if (entityType === '') errors.push({ field: 'entityType', message: 'Name the record type.' });
  if (entityId === '') errors.push({ field: 'entityId', message: 'Name the record.' });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      workflowDefinitionId: preview.value.workflowDefinitionId,
      entityType: clamp(entityType, 60),
      entityId: clamp(entityId, 60),
      context: preview.value.context,
    },
  };
}
