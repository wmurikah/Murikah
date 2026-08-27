/**
 * Reads and writes for workflow authority configuration.
 *
 * Five subjects: workflow roles, their assignments, the authority rules that
 * restrict an assignment, workflow definitions and their stages. Everything
 * here is configuration; nothing here decides authority. The decision lives in
 * ../workflow/resolver.ts, once.
 *
 * NOTHING IS DELETED, ALMOST
 * A workflow role and an assignment deactivate with `active = 0`, and an
 * assignment is superseded by closing it with `effective_to` and inserting a
 * new row, never by overwriting the substantive holder's row. The exception is
 * a stage on a definition with no instances, which may be removed while the
 * definition is still being drafted; once a definition has been used, section
 * 12's rule applies and the definition is versioned rather than edited.
 *
 * EVERY WRITE CARRIES ITS AUDIT ROW IN THE SAME BATCH
 * None of these tables has an `updated_at`, so a change with no audit row
 * leaves no evidence it happened. `db.batch([...], 'write')` makes the change
 * and its record one operation.
 */
import type { Client, InStatement } from '@libsql/client/web';
import type { FieldError } from '../../validation.ts';
import { newId, auditEventStmt } from './authRecords.ts';
import type { WriteContext } from '../admin/guard.ts';
import {
  WORKFLOW_AUDIT,
  type ApprovalMode,
  type AssignmentType,
  type ProcessType,
  type WorkflowScopeType,
} from '../workflow/model.ts';

type Stmt = Extract<InStatement, { sql: string }>;

export type WriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: 'conflict'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'invalid_reference'; readonly fields: FieldError[] }
  | { readonly ok: false; readonly kind: 'not_found' };

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const nullableNumber = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const flag = (v: unknown): boolean => Number(v ?? 0) === 1;
const isUnique = (e: unknown) =>
  /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));
const isCheck = (e: unknown) =>
  /CHECK constraint failed/i.test(e instanceof Error ? e.message : String(e));
const isForeignKey = (e: unknown) =>
  /FOREIGN KEY constraint failed/i.test(e instanceof Error ? e.message : String(e));

function audit(
  ctx: WriteContext,
  eventType: string,
  entityType: string,
  entityId: string,
  action: string,
  before: unknown,
  after: unknown,
): Stmt {
  return auditEventStmt({
    actorUserId: ctx.actorUserId,
    eventType,
    entityType,
    entityId,
    action,
    beforeJson: before === null ? null : JSON.stringify(before),
    afterJson: after === null ? null : JSON.stringify(after),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    now: ctx.now,
  }) as Stmt;
}

// ---- workflow roles --------------------------------------------------------

export interface WorkflowRoleRow {
  workflowRoleId: string;
  roleCode: string;
  roleName: string;
  /** Null means the role spans every process. That is how the seed uses it. */
  processType: ProcessType | null;
  description: string | null;
  active: boolean;
  assignmentCount: number;
  /**
   * Live assignments carrying no authority rule.
   *
   * Section 6 requires the screens to warn about these, because under the rule
   * this product applies they are unrestricted approvers, and an operator who
   * created the assignment and never got round to the rule should see the reach
   * they actually granted rather than the reach they meant to.
   */
  unrestrictedAssignmentCount: number;
}

const ROLE_SELECT = `
  SELECT r.workflow_role_id, r.role_code, r.role_name, r.process_type, r.description, r.active,
         (SELECT COUNT(*) FROM workflow_role_assignments a
           WHERE a.workflow_role_id = r.workflow_role_id AND a.active = 1) AS assignment_count,
         (SELECT COUNT(*) FROM workflow_role_assignments a
           WHERE a.workflow_role_id = r.workflow_role_id AND a.active = 1
             AND NOT EXISTS (SELECT 1 FROM approval_authority_rules ar
                              WHERE ar.workflow_role_assignment_id = a.workflow_role_assignment_id
                                AND ar.active = 1)) AS unrestricted_count
  FROM workflow_roles r`;

function toRole(row: Record<string, unknown>): WorkflowRoleRow {
  return {
    workflowRoleId: text(row.workflow_role_id),
    roleCode: text(row.role_code),
    roleName: text(row.role_name),
    processType: row.process_type === null ? null : (text(row.process_type) as ProcessType),
    description: nullableText(row.description),
    active: flag(row.active),
    assignmentCount: Number(row.assignment_count ?? 0),
    unrestrictedAssignmentCount: Number(row.unrestricted_count ?? 0),
  };
}

export async function listWorkflowRoles(db: Client): Promise<WorkflowRoleRow[]> {
  const result = await db.execute(`${ROLE_SELECT} ORDER BY r.role_name`);
  return result.rows.map((row) => toRole(row as unknown as Record<string, unknown>));
}

export async function getWorkflowRole(db: Client, id: string): Promise<WorkflowRoleRow | null> {
  const result = await db.execute({
    sql: `${ROLE_SELECT} WHERE r.workflow_role_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row === undefined ? null : toRole(row as unknown as Record<string, unknown>);
}

export interface WorkflowRoleInput {
  roleCode: string;
  roleName: string;
  processType: ProcessType | null;
  description: string | null;
  active: boolean;
}

export async function createWorkflowRole(
  db: Client,
  input: WorkflowRoleInput,
  ctx: WriteContext,
): Promise<WriteResult<WorkflowRoleRow>> {
  const id = newId('WROLE');
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO workflow_roles
                  (workflow_role_id, role_code, role_name, process_type, description, active)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            input.roleCode,
            input.roleName,
            input.processType,
            input.description,
            input.active ? 1 : 0,
          ],
        },
        audit(ctx, WORKFLOW_AUDIT.roleCreated, 'WORKFLOW_ROLE', id, 'CREATE', null, input),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) {
      const onCode = /role_code/i.test(error instanceof Error ? error.message : '');
      return {
        ok: false,
        kind: 'conflict',
        fields: [
          onCode
            ? { field: 'roleCode', message: 'That code is already in use.' }
            : { field: 'roleName', message: 'That name is already in use.' },
        ],
      };
    }
    if (isCheck(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'processType', message: 'Choose a process type or leave it empty.' }],
      };
    }
    throw error;
  }
  const created = await getWorkflowRole(db, id);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

export async function updateWorkflowRole(
  db: Client,
  id: string,
  input: WorkflowRoleInput,
  ctx: WriteContext,
): Promise<WriteResult<WorkflowRoleRow>> {
  const before = await getWorkflowRole(db, id);
  if (before === null) return { ok: false, kind: 'not_found' };
  try {
    await db.batch(
      [
        {
          // `role_code` is not in the SET list. A code is quoted in
          // configuration an operator may have written down elsewhere, and
          // renaming it silently repoints every reference to it.
          sql: `UPDATE workflow_roles
                SET role_name = ?, process_type = ?, description = ?, active = ?
                WHERE workflow_role_id = ?`,
          args: [input.roleName, input.processType, input.description, input.active ? 1 : 0, id],
        },
        audit(ctx, WORKFLOW_AUDIT.roleChanged, 'WORKFLOW_ROLE', id, 'UPDATE', before, input),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'roleName', message: 'That name is already in use.' }],
      };
    }
    if (isCheck(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'processType', message: 'Choose a process type or leave it empty.' }],
      };
    }
    throw error;
  }
  const after = await getWorkflowRole(db, id);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- workflow role assignments ---------------------------------------------

export interface WorkflowAssignmentRow {
  assignmentId: string;
  workflowRoleId: string;
  workflowRoleName: string;
  userId: string;
  displayName: string;
  scopeType: WorkflowScopeType;
  countryId: string | null;
  affiliateId: string | null;
  businessUnitId: string | null;
  scopeTargetId: string | null;
  scopeTargetName: string | null;
  priority: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  ruleCount: number;
  /** Section 6's warning, per assignment. */
  unrestricted: boolean;
}

const ASSIGNMENT_SELECT = `
  SELECT a.workflow_role_assignment_id, a.workflow_role_id, r.role_name, a.user_id,
         u.display_name, a.scope_type, a.country_id, a.affiliate_id, a.business_unit_id,
         a.priority, a.effective_from, a.effective_to, a.active,
         c.country_name, af.affiliate_name, bu.business_unit_name,
         (SELECT COUNT(*) FROM approval_authority_rules ar
           WHERE ar.workflow_role_assignment_id = a.workflow_role_assignment_id
             AND ar.active = 1) AS rule_count
  FROM workflow_role_assignments a
  JOIN workflow_roles r ON r.workflow_role_id = a.workflow_role_id
  JOIN users u ON u.user_id = a.user_id
  LEFT JOIN countries c ON c.country_id = a.country_id
  LEFT JOIN affiliates af ON af.affiliate_id = a.affiliate_id
  LEFT JOIN business_units bu ON bu.business_unit_id = a.business_unit_id`;

function toAssignment(row: Record<string, unknown>): WorkflowAssignmentRow {
  const scopeType = text(row.scope_type) as WorkflowScopeType;
  const target =
    scopeType === 'BUSINESS_UNIT'
      ? { id: nullableText(row.business_unit_id), name: nullableText(row.business_unit_name) }
      : scopeType === 'AFFILIATE'
        ? { id: nullableText(row.affiliate_id), name: nullableText(row.affiliate_name) }
        : scopeType === 'COUNTRY'
          ? { id: nullableText(row.country_id), name: nullableText(row.country_name) }
          : { id: null, name: null };
  const ruleCount = Number(row.rule_count ?? 0);
  return {
    assignmentId: text(row.workflow_role_assignment_id),
    workflowRoleId: text(row.workflow_role_id),
    workflowRoleName: text(row.role_name),
    userId: text(row.user_id),
    displayName: text(row.display_name),
    scopeType,
    countryId: nullableText(row.country_id),
    affiliateId: nullableText(row.affiliate_id),
    businessUnitId: nullableText(row.business_unit_id),
    scopeTargetId: target.id,
    scopeTargetName: target.name,
    priority: Number(row.priority ?? 100),
    effectiveFrom: text(row.effective_from),
    effectiveTo: nullableText(row.effective_to),
    active: flag(row.active),
    ruleCount,
    unrestricted: ruleCount === 0,
  };
}

export async function listAssignmentsForRole(
  db: Client,
  workflowRoleId: string,
): Promise<WorkflowAssignmentRow[]> {
  const result = await db.execute({
    sql: `${ASSIGNMENT_SELECT} WHERE a.workflow_role_id = ?
          ORDER BY a.active DESC, a.priority, a.effective_from DESC`,
    args: [workflowRoleId],
  });
  return result.rows.map((row) => toAssignment(row as unknown as Record<string, unknown>));
}

export async function getAssignment(db: Client, id: string): Promise<WorkflowAssignmentRow | null> {
  const result = await db.execute({
    sql: `${ASSIGNMENT_SELECT} WHERE a.workflow_role_assignment_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row === undefined ? null : toAssignment(row as unknown as Record<string, unknown>);
}

export interface AssignmentInput {
  workflowRoleId: string;
  userId: string;
  scopeType: WorkflowScopeType;
  countryId: string | null;
  affiliateId: string | null;
  businessUnitId: string | null;
  priority: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
}

/**
 * The columns the scope excludes are sent as NULL, never as an empty string.
 *
 * The table's CHECK insists on it: a `GROUP` row with `affiliate_id = ''` is
 * rejected, and an empty string is not NULL. Doing it here, once, means no
 * caller can get it wrong, and the browser's empty text input becomes NULL at
 * the boundary rather than reaching the database.
 */
function scopeColumns(input: AssignmentInput): {
  countryId: string | null;
  affiliateId: string | null;
  businessUnitId: string | null;
} {
  switch (input.scopeType) {
    case 'GROUP':
      return { countryId: null, affiliateId: null, businessUnitId: null };
    case 'COUNTRY':
      return { countryId: input.countryId, affiliateId: null, businessUnitId: null };
    case 'AFFILIATE':
      return { countryId: input.countryId, affiliateId: input.affiliateId, businessUnitId: null };
    case 'BUSINESS_UNIT':
      return {
        countryId: input.countryId,
        affiliateId: input.affiliateId,
        businessUnitId: input.businessUnitId,
      };
  }
}

export async function createAssignment(
  db: Client,
  input: AssignmentInput,
  ctx: WriteContext,
): Promise<WriteResult<WorkflowAssignmentRow>> {
  const id = newId('WRA');
  const scope = scopeColumns(input);
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO workflow_role_assignments
                  (workflow_role_assignment_id, workflow_role_id, user_id, scope_type,
                   country_id, affiliate_id, business_unit_id, priority,
                   effective_from, effective_to, active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            input.workflowRoleId,
            input.userId,
            input.scopeType,
            scope.countryId,
            scope.affiliateId,
            scope.businessUnitId,
            input.priority,
            input.effectiveFrom,
            input.effectiveTo,
            input.active ? 1 : 0,
          ],
        },
        audit(ctx, WORKFLOW_AUDIT.roleAssigned, 'WORKFLOW_ROLE_ASSIGNMENT', id, 'CREATE', null, {
          ...input,
          ...scope,
        }),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [
          {
            field: 'effectiveFrom',
            message: 'That person already holds this role at this scope from that date.',
          },
        ],
      };
    }
    if (isCheck(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'scopeType', message: 'Choose the target that scope needs.' }],
      };
    }
    if (isForeignKey(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'userId', message: 'That person or scope target does not exist.' }],
      };
    }
    throw error;
  }
  const created = await getAssignment(db, id);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

/**
 * Close an assignment, without overwriting it.
 *
 * Only `effective_to` and `active` change. The scope, the person, the role and
 * the start date are the historical record of who held what and when, and a
 * delegation that rewrote them would make the audit trail describe a past that
 * did not happen. A new holder is a new row, which is also the delegation
 * mechanism in section 16.
 */
export async function supersedeAssignment(
  db: Client,
  id: string,
  input: { effectiveTo: string | null; active: boolean },
  ctx: WriteContext,
): Promise<WriteResult<WorkflowAssignmentRow>> {
  const before = await getAssignment(db, id);
  if (before === null) return { ok: false, kind: 'not_found' };
  try {
    await db.batch(
      [
        {
          sql: `UPDATE workflow_role_assignments
                SET effective_to = ?, active = ? WHERE workflow_role_assignment_id = ?`,
          args: [input.effectiveTo, input.active ? 1 : 0, id],
        },
        audit(
          ctx,
          WORKFLOW_AUDIT.roleAssigned,
          'WORKFLOW_ROLE_ASSIGNMENT',
          id,
          'SUPERSEDE',
          before,
          { ...before, ...input },
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isCheck(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [
          { field: 'effectiveTo', message: 'The end date cannot be before the start date.' },
        ],
      };
    }
    throw error;
  }
  const after = await getAssignment(db, id);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- approval authority rules ----------------------------------------------

export interface AuthorityRuleRow {
  ruleId: string;
  assignmentId: string;
  processType: string;
  currencyCode: string | null;
  minAmount: number | null;
  maxAmount: number | null;
  productGroupId: string | null;
  productGroupName: string | null;
  productCategoryId: string | null;
  productCategoryName: string | null;
  rulePriority: number;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  /**
   * The sentence the screen shows instead of an empty field.
   *
   * Section 4: a rule with no currency applies to all currencies, and the
   * interface must say so rather than leaving a blank the administrator has to
   * interpret. The sentence is built here so the list, the drawer and the
   * preview cannot describe the same rule three different ways.
   */
  summary: string;
}

const RULE_SELECT = `
  SELECT ar.authority_rule_id, ar.workflow_role_assignment_id, ar.process_type, ar.currency_code,
         ar.min_amount, ar.max_amount, ar.product_group_id, ar.product_category_id,
         ar.rule_priority, ar.active, ar.effective_from, ar.effective_to,
         pg.group_name, pc.category_name
  FROM approval_authority_rules ar
  LEFT JOIN product_groups pg ON pg.product_group_id = ar.product_group_id
  LEFT JOIN product_categories pc ON pc.product_category_id = ar.product_category_id`;

export function describeRule(rule: {
  currencyCode: string | null;
  minAmount: number | null;
  maxAmount: number | null;
  productGroupName: string | null;
  productCategoryName: string | null;
}): string {
  const parts: string[] = [];
  parts.push(rule.currencyCode === null ? 'Any currency' : `Currency ${rule.currencyCode} only`);
  if (rule.minAmount === null && rule.maxAmount === null) {
    parts.push('any amount');
  } else if (rule.maxAmount === null) {
    parts.push(`${rule.minAmount ?? 0} and above`);
  } else if (rule.minAmount === null) {
    parts.push(`up to ${rule.maxAmount}`);
  } else {
    parts.push(`${rule.minAmount} to ${rule.maxAmount}`);
  }
  if (rule.productCategoryName !== null) {
    parts.push(`category ${rule.productCategoryName} only`);
  } else if (rule.productGroupName !== null) {
    parts.push(`product group ${rule.productGroupName} only`);
  } else {
    parts.push('any product');
  }
  return `${parts.join(', ')}.`;
}

function toRule(row: Record<string, unknown>): AuthorityRuleRow {
  const productGroupName = nullableText(row.group_name);
  const productCategoryName = nullableText(row.category_name);
  const currencyCode = nullableText(row.currency_code);
  const minAmount = nullableNumber(row.min_amount);
  const maxAmount = nullableNumber(row.max_amount);
  return {
    ruleId: text(row.authority_rule_id),
    assignmentId: text(row.workflow_role_assignment_id),
    processType: text(row.process_type),
    currencyCode,
    minAmount,
    maxAmount,
    productGroupId: nullableText(row.product_group_id),
    productGroupName,
    productCategoryId: nullableText(row.product_category_id),
    productCategoryName,
    rulePriority: Number(row.rule_priority ?? 100),
    active: flag(row.active),
    effectiveFrom: text(row.effective_from),
    effectiveTo: nullableText(row.effective_to),
    summary: describeRule({
      currencyCode,
      minAmount,
      maxAmount,
      productGroupName,
      productCategoryName,
    }),
  };
}

export async function listRulesForAssignment(
  db: Client,
  assignmentId: string,
): Promise<AuthorityRuleRow[]> {
  const result = await db.execute({
    sql: `${RULE_SELECT} WHERE ar.workflow_role_assignment_id = ?
          ORDER BY ar.active DESC, ar.rule_priority, ar.authority_rule_id`,
    args: [assignmentId],
  });
  return result.rows.map((row) => toRule(row as unknown as Record<string, unknown>));
}

export async function getRule(db: Client, id: string): Promise<AuthorityRuleRow | null> {
  const result = await db.execute({
    sql: `${RULE_SELECT} WHERE ar.authority_rule_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row === undefined ? null : toRule(row as unknown as Record<string, unknown>);
}

export interface AuthorityRuleInput {
  assignmentId: string;
  processType: string;
  currencyCode: string | null;
  minAmount: number | null;
  maxAmount: number | null;
  productGroupId: string | null;
  productCategoryId: string | null;
  rulePriority: number;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export async function createRule(
  db: Client,
  input: AuthorityRuleInput,
  ctx: WriteContext,
): Promise<WriteResult<AuthorityRuleRow>> {
  const id = newId('AAR');
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO approval_authority_rules
                  (authority_rule_id, workflow_role_assignment_id, process_type, currency_code,
                   min_amount, max_amount, product_group_id, product_category_id,
                   rule_priority, active, effective_from, effective_to)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            input.assignmentId,
            input.processType,
            input.currencyCode,
            input.minAmount,
            input.maxAmount,
            input.productGroupId,
            input.productCategoryId,
            input.rulePriority,
            input.active ? 1 : 0,
            input.effectiveFrom,
            input.effectiveTo,
          ],
        },
        audit(ctx, WORKFLOW_AUDIT.ruleCreated, 'AUTHORITY_RULE', id, 'CREATE', null, input),
      ],
      'write',
    );
  } catch (error) {
    if (isCheck(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [
          {
            field: 'maxAmount',
            message: 'Check the process type, the amounts and the dates.',
          },
        ],
      };
    }
    if (isForeignKey(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'assignmentId', message: 'That assignment or product does not exist.' }],
      };
    }
    throw error;
  }
  const created = await getRule(db, id);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

export async function updateRule(
  db: Client,
  id: string,
  input: AuthorityRuleInput,
  ctx: WriteContext,
): Promise<WriteResult<AuthorityRuleRow>> {
  const before = await getRule(db, id);
  if (before === null) return { ok: false, kind: 'not_found' };
  try {
    await db.batch(
      [
        {
          sql: `UPDATE approval_authority_rules
                SET process_type = ?, currency_code = ?, min_amount = ?, max_amount = ?,
                    product_group_id = ?, product_category_id = ?, rule_priority = ?,
                    active = ?, effective_from = ?, effective_to = ?
                WHERE authority_rule_id = ?`,
          args: [
            input.processType,
            input.currencyCode,
            input.minAmount,
            input.maxAmount,
            input.productGroupId,
            input.productCategoryId,
            input.rulePriority,
            input.active ? 1 : 0,
            input.effectiveFrom,
            input.effectiveTo,
            id,
          ],
        },
        audit(ctx, WORKFLOW_AUDIT.ruleChanged, 'AUTHORITY_RULE', id, 'UPDATE', before, input),
      ],
      'write',
    );
  } catch (error) {
    if (isCheck(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'maxAmount', message: 'Check the amounts and the dates.' }],
      };
    }
    throw error;
  }
  const after = await getRule(db, id);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

// ---- workflow definitions and stages ---------------------------------------

export interface WorkflowDefinitionRow {
  workflowDefinitionId: string;
  workflowName: string;
  processType: ProcessType;
  countryId: string | null;
  affiliateId: string | null;
  businessUnitId: string | null;
  versionNo: number;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  stageCount: number;
  /**
   * Live workflow instances created under this definition.
   *
   * Section 12's gate: a definition with instances is not edited in place. The
   * count is here rather than in the endpoint so the screen and the guard agree
   * about what "in use" means.
   */
  instanceCount: number;
}

const DEFINITION_SELECT = `
  SELECT d.workflow_definition_id, d.workflow_name, d.process_type, d.country_id,
         d.affiliate_id, d.business_unit_id, d.version_no, d.active, d.effective_from,
         d.effective_to,
         (SELECT COUNT(*) FROM workflow_stages s
           WHERE s.workflow_definition_id = d.workflow_definition_id) AS stage_count,
         (SELECT COUNT(*) FROM workflow_instances i
           WHERE i.workflow_definition_id = d.workflow_definition_id) AS instance_count
  FROM workflow_definitions d`;

function toDefinition(row: Record<string, unknown>): WorkflowDefinitionRow {
  return {
    workflowDefinitionId: text(row.workflow_definition_id),
    workflowName: text(row.workflow_name),
    processType: text(row.process_type) as ProcessType,
    countryId: nullableText(row.country_id),
    affiliateId: nullableText(row.affiliate_id),
    businessUnitId: nullableText(row.business_unit_id),
    versionNo: Number(row.version_no ?? 1),
    active: flag(row.active),
    effectiveFrom: text(row.effective_from),
    effectiveTo: nullableText(row.effective_to),
    stageCount: Number(row.stage_count ?? 0),
    instanceCount: Number(row.instance_count ?? 0),
  };
}

export async function listDefinitions(db: Client): Promise<WorkflowDefinitionRow[]> {
  const result = await db.execute(`${DEFINITION_SELECT} ORDER BY d.workflow_name, d.version_no`);
  return result.rows.map((row) => toDefinition(row as unknown as Record<string, unknown>));
}

export async function getDefinition(db: Client, id: string): Promise<WorkflowDefinitionRow | null> {
  const result = await db.execute({
    sql: `${DEFINITION_SELECT} WHERE d.workflow_definition_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row === undefined ? null : toDefinition(row as unknown as Record<string, unknown>);
}

export interface DefinitionInput {
  workflowName: string;
  processType: ProcessType;
  countryId: string | null;
  affiliateId: string | null;
  businessUnitId: string | null;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export async function createDefinition(
  db: Client,
  input: DefinitionInput,
  ctx: WriteContext,
): Promise<WriteResult<WorkflowDefinitionRow>> {
  const id = newId('WFD');
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO workflow_definitions
                  (workflow_definition_id, workflow_name, process_type, country_id, affiliate_id,
                   business_unit_id, version_no, active, effective_from, effective_to)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          args: [
            id,
            input.workflowName,
            input.processType,
            input.countryId,
            input.affiliateId,
            input.businessUnitId,
            input.active ? 1 : 0,
            input.effectiveFrom,
            input.effectiveTo,
          ],
        },
        audit(ctx, WORKFLOW_AUDIT.workflowCreated, 'WORKFLOW_DEFINITION', id, 'CREATE', null, {
          ...input,
          versionNo: 1,
        }),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'workflowName', message: 'That workflow name is already in use.' }],
      };
    }
    if (isCheck(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'processType', message: 'Choose a process type.' }],
      };
    }
    throw error;
  }
  const created = await getDefinition(db, id);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

/**
 * Edit a definition in place, and only while nothing has used it.
 *
 * Section 12. Once a workflow instance exists, the definition describes what
 * that record went through, and changing it rewrites history for every one of
 * them. `newVersion` is the way forward from there. `active` and
 * `effective_to` are the exception: retiring a version is not a change to what
 * it meant, it is a statement that it no longer applies to new transactions,
 * and it must stay possible or a version could never be superseded.
 */
export async function updateDefinition(
  db: Client,
  id: string,
  input: DefinitionInput,
  ctx: WriteContext,
): Promise<WriteResult<WorkflowDefinitionRow>> {
  const before = await getDefinition(db, id);
  if (before === null) return { ok: false, kind: 'not_found' };

  const substantive =
    before.workflowName !== input.workflowName ||
    before.processType !== input.processType ||
    before.countryId !== input.countryId ||
    before.affiliateId !== input.affiliateId ||
    before.businessUnitId !== input.businessUnitId ||
    before.effectiveFrom !== input.effectiveFrom;

  if (before.instanceCount > 0 && substantive) {
    return {
      ok: false,
      kind: 'conflict',
      fields: [
        {
          field: 'workflowName',
          message:
            'This version is already in use. Create a new version instead of editing this one.',
        },
      ],
    };
  }

  try {
    await db.batch(
      [
        {
          sql: `UPDATE workflow_definitions
                SET workflow_name = ?, process_type = ?, country_id = ?, affiliate_id = ?,
                    business_unit_id = ?, active = ?, effective_from = ?, effective_to = ?
                WHERE workflow_definition_id = ?`,
          args: [
            input.workflowName,
            input.processType,
            input.countryId,
            input.affiliateId,
            input.businessUnitId,
            input.active ? 1 : 0,
            input.effectiveFrom,
            input.effectiveTo,
            id,
          ],
        },
        audit(
          ctx,
          WORKFLOW_AUDIT.workflowCreated,
          'WORKFLOW_DEFINITION',
          id,
          'UPDATE',
          before,
          input,
        ),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'workflowName', message: 'That name and version already exist.' }],
      };
    }
    throw error;
  }
  const after = await getDefinition(db, id);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

/**
 * A new version of a definition, with its stages copied forward.
 *
 * `UNIQUE(workflow_name, version_no)` means the name carries the identity and
 * the version number distinguishes them, so the new row keeps the name and
 * takes the next number. Existing instances keep pointing at the old row and
 * therefore keep meaning what they meant, which is section 12 in one sentence.
 */
export async function newVersion(
  db: Client,
  id: string,
  input: { effectiveFrom: string; retirePrevious: boolean },
  ctx: WriteContext,
): Promise<WriteResult<WorkflowDefinitionRow>> {
  const before = await getDefinition(db, id);
  if (before === null) return { ok: false, kind: 'not_found' };

  const highest = await db.execute({
    sql: `SELECT MAX(version_no) AS top FROM workflow_definitions WHERE workflow_name = ?`,
    args: [before.workflowName],
  });
  const nextVersion = Number(highest.rows[0]?.top ?? before.versionNo) + 1;
  const newDefinitionId = newId('WFD');

  const stages = await db.execute({
    sql: `SELECT stage_code, stage_name, sequence_no, assignment_type, assigned_user_id,
                 assigned_workflow_role_id, assigned_team_id, approval_mode,
                 required_approvals, sla_rule_id, terminal_stage
          FROM workflow_stages WHERE workflow_definition_id = ? ORDER BY sequence_no`,
    args: [id],
  });

  const statements: Stmt[] = [
    {
      sql: `INSERT INTO workflow_definitions
              (workflow_definition_id, workflow_name, process_type, country_id, affiliate_id,
               business_unit_id, version_no, active, effective_from, effective_to)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)`,
      args: [
        newDefinitionId,
        before.workflowName,
        before.processType,
        before.countryId,
        before.affiliateId,
        before.businessUnitId,
        nextVersion,
        input.effectiveFrom,
      ],
    },
  ];

  for (const row of stages.rows) {
    statements.push({
      sql: `INSERT INTO workflow_stages
              (workflow_stage_id, workflow_definition_id, stage_code, stage_name, sequence_no,
               assignment_type, assigned_user_id, assigned_workflow_role_id, assigned_team_id,
               approval_mode, required_approvals, sla_rule_id, terminal_stage)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('WST'),
        newDefinitionId,
        text(row.stage_code),
        text(row.stage_name),
        Number(row.sequence_no ?? 1),
        text(row.assignment_type),
        nullableText(row.assigned_user_id),
        nullableText(row.assigned_workflow_role_id),
        nullableText(row.assigned_team_id),
        text(row.approval_mode),
        Number(row.required_approvals ?? 1),
        nullableText(row.sla_rule_id),
        Number(row.terminal_stage ?? 0),
      ],
    });
  }

  if (input.retirePrevious) {
    statements.push({
      sql: `UPDATE workflow_definitions SET effective_to = ?, active = 0
            WHERE workflow_definition_id = ?`,
      args: [input.effectiveFrom, id],
    });
  }

  statements.push(
    audit(
      ctx,
      WORKFLOW_AUDIT.versionCreated,
      'WORKFLOW_DEFINITION',
      newDefinitionId,
      'CREATE',
      { workflowDefinitionId: id, versionNo: before.versionNo },
      {
        workflowDefinitionId: newDefinitionId,
        versionNo: nextVersion,
        effectiveFrom: input.effectiveFrom,
        copiedStages: stages.rows.length,
        retiredPrevious: input.retirePrevious,
      },
    ),
  );

  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (isUnique(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'versionNo', message: 'That version already exists.' }],
      };
    }
    throw error;
  }
  const created = await getDefinition(db, newDefinitionId);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

/**
 * The definition that applies to a transaction on a date.
 *
 * Most specific applicability first, exactly as the resolver ranks scopes, then
 * the highest effective version. Nothing here reads a workflow name.
 */
export async function pickDefinition(
  db: Client,
  input: {
    processType: ProcessType;
    countryId: string | null;
    affiliateId: string | null;
    businessUnitId: string | null;
    onDate: string;
  },
): Promise<WorkflowDefinitionRow | null> {
  const result = await db.execute({
    sql: `${DEFINITION_SELECT}
          WHERE d.process_type = ? AND d.active = 1
            AND d.effective_from <= ?
            AND (d.effective_to IS NULL OR d.effective_to >= ?)
            AND (d.country_id IS NULL OR d.country_id = ?)
            AND (d.affiliate_id IS NULL OR d.affiliate_id = ?)
            AND (d.business_unit_id IS NULL OR d.business_unit_id = ?)
          ORDER BY (d.business_unit_id IS NOT NULL) DESC,
                   (d.affiliate_id IS NOT NULL) DESC,
                   (d.country_id IS NOT NULL) DESC,
                   d.version_no DESC
          LIMIT 1`,
    args: [
      input.processType,
      input.onDate,
      input.onDate,
      input.countryId,
      input.affiliateId,
      input.businessUnitId,
    ],
  });
  const row = result.rows[0];
  return row === undefined ? null : toDefinition(row as unknown as Record<string, unknown>);
}

export interface StageRow {
  workflowStageId: string;
  workflowDefinitionId: string;
  stageCode: string;
  stageName: string;
  sequenceNo: number;
  assignmentType: AssignmentType;
  assignedUserId: string | null;
  assignedUserName: string | null;
  assignedWorkflowRoleId: string | null;
  assignedWorkflowRoleName: string | null;
  assignedTeamId: string | null;
  assignedTeamName: string | null;
  approvalMode: ApprovalMode;
  requiredApprovals: number;
  slaRuleId: string | null;
  terminalStage: boolean;
}

const STAGE_SELECT = `
  SELECT s.workflow_stage_id, s.workflow_definition_id, s.stage_code, s.stage_name,
         s.sequence_no, s.assignment_type, s.assigned_user_id, s.assigned_workflow_role_id,
         s.assigned_team_id, s.approval_mode, s.required_approvals, s.sla_rule_id,
         s.terminal_stage, u.display_name, r.role_name, t.team_name
  FROM workflow_stages s
  LEFT JOIN users u ON u.user_id = s.assigned_user_id
  LEFT JOIN workflow_roles r ON r.workflow_role_id = s.assigned_workflow_role_id
  LEFT JOIN teams t ON t.team_id = s.assigned_team_id`;

function toStage(row: Record<string, unknown>): StageRow {
  return {
    workflowStageId: text(row.workflow_stage_id),
    workflowDefinitionId: text(row.workflow_definition_id),
    stageCode: text(row.stage_code),
    stageName: text(row.stage_name),
    sequenceNo: Number(row.sequence_no ?? 1),
    assignmentType: text(row.assignment_type) as AssignmentType,
    assignedUserId: nullableText(row.assigned_user_id),
    assignedUserName: nullableText(row.display_name),
    assignedWorkflowRoleId: nullableText(row.assigned_workflow_role_id),
    assignedWorkflowRoleName: nullableText(row.role_name),
    assignedTeamId: nullableText(row.assigned_team_id),
    assignedTeamName: nullableText(row.team_name),
    approvalMode: text(row.approval_mode) as ApprovalMode,
    requiredApprovals: Number(row.required_approvals ?? 1),
    slaRuleId: nullableText(row.sla_rule_id),
    terminalStage: Number(row.terminal_stage ?? 0) === 1,
  };
}

export async function listStages(db: Client, definitionId: string): Promise<StageRow[]> {
  const result = await db.execute({
    sql: `${STAGE_SELECT} WHERE s.workflow_definition_id = ? ORDER BY s.sequence_no`,
    args: [definitionId],
  });
  return result.rows.map((row) => toStage(row as unknown as Record<string, unknown>));
}

export async function getStage(db: Client, id: string): Promise<StageRow | null> {
  const result = await db.execute({
    sql: `${STAGE_SELECT} WHERE s.workflow_stage_id = ? LIMIT 1`,
    args: [id],
  });
  const row = result.rows[0];
  return row === undefined ? null : toStage(row as unknown as Record<string, unknown>);
}

export interface StageInput {
  stageCode: string;
  stageName: string;
  sequenceNo: number;
  assignmentType: AssignmentType;
  assignedUserId: string | null;
  assignedWorkflowRoleId: string | null;
  assignedTeamId: string | null;
  approvalMode: ApprovalMode;
  requiredApprovals: number;
  slaRuleId: string | null;
  terminalStage: boolean;
}

/**
 * The assignment target the type owns, and NULL for the other two.
 *
 * The same discipline as `scopeColumns`: a stage whose type is WORKFLOW_ROLE
 * must not also carry a stale `assigned_user_id` from an earlier edit, because
 * the runtime would then have two answers to "who does this stage go to" and
 * would pick by type, silently ignoring a field the screen still shows.
 */
function assignmentColumns(input: StageInput): {
  userId: string | null;
  roleId: string | null;
  teamId: string | null;
} {
  switch (input.assignmentType) {
    case 'USER':
      return { userId: input.assignedUserId, roleId: null, teamId: input.assignedTeamId };
    case 'WORKFLOW_ROLE':
      return { userId: null, roleId: input.assignedWorkflowRoleId, teamId: input.assignedTeamId };
    case 'TEAM':
      return { userId: null, roleId: null, teamId: input.assignedTeamId };
    case 'SYSTEM':
      return { userId: null, roleId: null, teamId: null };
  }
}

export async function createStage(
  db: Client,
  definitionId: string,
  input: StageInput,
  ctx: WriteContext,
): Promise<WriteResult<StageRow>> {
  const definition = await getDefinition(db, definitionId);
  if (definition === null) return { ok: false, kind: 'not_found' };
  if (definition.instanceCount > 0) {
    return {
      ok: false,
      kind: 'conflict',
      fields: [
        {
          field: 'stageCode',
          message: 'This version is already in use. Create a new version to change its stages.',
        },
      ],
    };
  }
  const id = newId('WST');
  const target = assignmentColumns(input);
  try {
    await db.batch(
      [
        {
          sql: `INSERT INTO workflow_stages
                  (workflow_stage_id, workflow_definition_id, stage_code, stage_name, sequence_no,
                   assignment_type, assigned_user_id, assigned_workflow_role_id, assigned_team_id,
                   approval_mode, required_approvals, sla_rule_id, terminal_stage)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            id,
            definitionId,
            input.stageCode,
            input.stageName,
            input.sequenceNo,
            input.assignmentType,
            target.userId,
            target.roleId,
            target.teamId,
            input.approvalMode,
            input.requiredApprovals,
            input.slaRuleId,
            input.terminalStage ? 1 : 0,
          ],
        },
        audit(ctx, WORKFLOW_AUDIT.stageChanged, 'WORKFLOW_STAGE', id, 'CREATE', null, {
          ...input,
          workflowDefinitionId: definitionId,
        }),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) {
      const onSequence = /sequence_no/i.test(error instanceof Error ? error.message : '');
      return {
        ok: false,
        kind: 'conflict',
        fields: [
          onSequence
            ? { field: 'sequenceNo', message: 'Another stage already holds that position.' }
            : { field: 'stageCode', message: 'That stage code is already used in this workflow.' },
        ],
      };
    }
    if (isCheck(error) || isForeignKey(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [
          { field: 'assignmentType', message: 'Check the assignment target and approval mode.' },
        ],
      };
    }
    throw error;
  }
  const created = await getStage(db, id);
  return created === null ? { ok: false, kind: 'not_found' } : { ok: true, value: created };
}

export async function updateStage(
  db: Client,
  id: string,
  input: StageInput,
  ctx: WriteContext,
): Promise<WriteResult<StageRow>> {
  const before = await getStage(db, id);
  if (before === null) return { ok: false, kind: 'not_found' };
  const definition = await getDefinition(db, before.workflowDefinitionId);
  if (definition !== null && definition.instanceCount > 0) {
    return {
      ok: false,
      kind: 'conflict',
      fields: [
        {
          field: 'stageCode',
          message: 'This version is already in use. Create a new version to change its stages.',
        },
      ],
    };
  }
  const target = assignmentColumns(input);
  try {
    await db.batch(
      [
        {
          sql: `UPDATE workflow_stages
                SET stage_code = ?, stage_name = ?, assignment_type = ?, assigned_user_id = ?,
                    assigned_workflow_role_id = ?, assigned_team_id = ?, approval_mode = ?,
                    required_approvals = ?, sla_rule_id = ?, terminal_stage = ?
                WHERE workflow_stage_id = ?`,
          args: [
            input.stageCode,
            input.stageName,
            input.assignmentType,
            target.userId,
            target.roleId,
            target.teamId,
            input.approvalMode,
            input.requiredApprovals,
            input.slaRuleId,
            input.terminalStage ? 1 : 0,
            id,
          ],
        },
        audit(ctx, WORKFLOW_AUDIT.stageChanged, 'WORKFLOW_STAGE', id, 'UPDATE', before, input),
      ],
      'write',
    );
  } catch (error) {
    if (isUnique(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [
          { field: 'stageCode', message: 'That stage code is already used in this workflow.' },
        ],
      };
    }
    if (isCheck(error) || isForeignKey(error)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [
          { field: 'assignmentType', message: 'Check the assignment target and approval mode.' },
        ],
      };
    }
    throw error;
  }
  const after = await getStage(db, id);
  return after === null ? { ok: false, kind: 'not_found' } : { ok: true, value: after };
}

/**
 * Reorder a definition's stages.
 *
 * `UNIQUE(workflow_definition_id, sequence_no)` rejects a naive pass that
 * momentarily gives two stages the same position, and swapping two adjacent
 * stages does exactly that on its first statement. So the reorder runs in two
 * passes inside one `batch(..., 'write')`:
 *
 *   1. Every stage of this definition is pushed up by the definition's current
 *      maximum sequence, which vacates the whole low range in one statement and
 *      cannot collide, because the offset is at least as large as any value in
 *      use. `CHECK(sequence_no > 0)` rules out the obvious alternative of going
 *      negative.
 *   2. Each stage is then set to its final position, all of which are free.
 *
 * A batch is one transaction, so a caller never observes the offset range.
 */
export async function reorderStages(
  db: Client,
  definitionId: string,
  order: readonly { stageId: string; sequenceNo: number }[],
  ctx: WriteContext,
): Promise<WriteResult<StageRow[]>> {
  const definition = await getDefinition(db, definitionId);
  if (definition === null) return { ok: false, kind: 'not_found' };
  if (definition.instanceCount > 0) {
    return {
      ok: false,
      kind: 'conflict',
      fields: [
        {
          field: 'order',
          message: 'This version is already in use. Create a new version to reorder its stages.',
        },
      ],
    };
  }

  const before = await listStages(db, definitionId);
  const known = new Set(before.map((stage) => stage.workflowStageId));
  for (const entry of order) {
    if (!known.has(entry.stageId)) {
      return {
        ok: false,
        kind: 'invalid_reference',
        fields: [{ field: 'order', message: 'That stage is not part of this workflow.' }],
      };
    }
  }

  const statements: Stmt[] = [
    {
      sql: `UPDATE workflow_stages
            SET sequence_no = sequence_no +
                  (SELECT MAX(sequence_no) FROM workflow_stages WHERE workflow_definition_id = ?)
            WHERE workflow_definition_id = ?`,
      args: [definitionId, definitionId],
    },
  ];
  for (const entry of order) {
    statements.push({
      sql: `UPDATE workflow_stages SET sequence_no = ? WHERE workflow_stage_id = ?`,
      args: [entry.sequenceNo, entry.stageId],
    });
  }
  statements.push(
    audit(
      ctx,
      WORKFLOW_AUDIT.stageChanged,
      'WORKFLOW_DEFINITION',
      definitionId,
      'REORDER',
      before.map((stage) => ({ stageId: stage.workflowStageId, sequenceNo: stage.sequenceNo })),
      order,
    ),
  );

  try {
    await db.batch(statements, 'write');
  } catch (error) {
    if (isUnique(error)) {
      return {
        ok: false,
        kind: 'conflict',
        fields: [{ field: 'order', message: 'Two stages were given the same position.' }],
      };
    }
    throw error;
  }
  return { ok: true, value: await listStages(db, definitionId) };
}

// ---- selection lists for the screens ---------------------------------------

export interface Option {
  id: string;
  label: string;
  parentId?: string | null;
}

export interface WorkflowOptions {
  users: Option[];
  countries: Option[];
  affiliates: Option[];
  businessUnits: Option[];
  teams: Option[];
  workflowRoles: Option[];
  productGroups: Option[];
  productCategories: Option[];
  slaRules: Option[];
}

/** Everything the workflow forms offer, in one round trip. */
export async function workflowOptions(db: Client): Promise<WorkflowOptions> {
  const [users, countries, affiliates, businessUnits, teams, roles, groups, categories, slaRules] =
    await db.batch(
      [
        `SELECT user_id AS id, display_name AS label FROM users
          WHERE status = 'ACTIVE' AND user_type = 'INTERNAL' ORDER BY display_name`,
        `SELECT country_id AS id, country_name AS label FROM countries WHERE active = 1
          ORDER BY country_name`,
        `SELECT affiliate_id AS id, affiliate_name AS label, country_id AS parent FROM affiliates
          WHERE active = 1 ORDER BY affiliate_name`,
        // `business_units` carries no affiliate: a business unit is a
        // group-wide line of business, and an assignment ties it to a country
        // and an affiliate on its own row. So there is no parent to offer here.
        `SELECT business_unit_id AS id, business_unit_name AS label
          FROM business_units WHERE active = 1 ORDER BY business_unit_name`,
        `SELECT team_id AS id, team_name AS label FROM teams WHERE active = 1 ORDER BY team_name`,
        `SELECT workflow_role_id AS id, role_name AS label FROM workflow_roles WHERE active = 1
          ORDER BY role_name`,
        `SELECT product_group_id AS id, group_name AS label FROM product_groups WHERE active = 1
          ORDER BY group_name`,
        `SELECT product_category_id AS id, category_name AS label, product_group_id AS parent
          FROM product_categories WHERE active = 1 ORDER BY category_name`,
        `SELECT sla_rule_id AS id, rule_name AS label FROM sla_rules WHERE active = 1
          ORDER BY rule_name`,
      ],
      'read',
    );

  const options = (result: { rows: Record<string, unknown>[] }): Option[] =>
    result.rows.map((row) => ({
      id: text(row.id),
      label: text(row.label),
      parentId: row.parent === undefined ? null : nullableText(row.parent),
    }));

  return {
    users: options(users as unknown as { rows: Record<string, unknown>[] }),
    countries: options(countries as unknown as { rows: Record<string, unknown>[] }),
    affiliates: options(affiliates as unknown as { rows: Record<string, unknown>[] }),
    businessUnits: options(businessUnits as unknown as { rows: Record<string, unknown>[] }),
    teams: options(teams as unknown as { rows: Record<string, unknown>[] }),
    workflowRoles: options(roles as unknown as { rows: Record<string, unknown>[] }),
    productGroups: options(groups as unknown as { rows: Record<string, unknown>[] }),
    productCategories: options(categories as unknown as { rows: Record<string, unknown>[] }),
    slaRules: options(slaRules as unknown as { rows: Record<string, unknown>[] }),
  };
}
