/**
 * The live path: creating a stage instance, persisting who may act on it, and
 * recording what they decided.
 *
 * PERSIST ACCOUNTABILITY ONCE
 * A stage resolves when it is created, and never again on a read. The eligible
 * approvers are written to `workflow_stage_assignees` with the
 * `workflow_role_assignment_id` that made each of them eligible, so the reason
 * survives a configuration change. Loading the stage afterwards reads that
 * table; it does not call the resolver. Re-resolution exists, in
 * `reResolveStage`, and it is a deliberate administrative action with its own
 * audit row. It is never implicit.
 *
 * That is not a performance choice. An approver who opened a stage yesterday
 * and finds it gone today, because somebody changed a threshold, has no way to
 * know what happened, and a stage whose assignee list moves under it cannot be
 * audited: the row saying "approved by" would no longer agree with the rule
 * that put them there.
 *
 * NOTHING HERE TRUSTS THE BROWSER
 * `recordDecision` takes the acting user from the session, through the
 * principal the caller resolved from the middleware. There is no parameter for
 * "who is approving". An endpoint cannot pass one, so a payload cannot set one.
 *
 * NO `workflow_events` TABLE
 * It does not exist in the schema and is not created. Every event below goes to
 * `audit_events` through the Build Prompt 03 writer.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { newId, auditEventStmt } from '../repos/authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';
import { WORKFLOW_AUDIT, type ApprovalMode, type ProcessType, type StageStatus } from './model.ts';
import {
  resolveApprovers,
  type ApproverMatch,
  type Resolution,
  type TransactionLine,
} from './resolver.ts';

type Stmt = Extract<InStatement, { sql: string }>;

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const nullableNumber = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

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

/**
 * The transaction facts a stage resolves against.
 *
 * The schema has nowhere to record these: `workflow_instances` carries an
 * entity type and an entity id and no context columns. So the caller supplies
 * them, once, when the stage is created, and they are written into the
 * `APPROVER_RESOLVED` audit row's after state, which is where an administrator
 * reads back what the decision was actually made on. A re-resolution restates
 * them for the same reason. Adding a column would be a schema change, which
 * this phase may not make.
 */
export interface TransactionContext {
  readonly processType: ProcessType;
  readonly countryId: string | null;
  readonly affiliateId: string | null;
  readonly businessUnitId: string | null;
  readonly amount: number | null;
  readonly currencyCode: string | null;
  readonly lines: readonly TransactionLine[];
  readonly eventDate: string;
}

export interface StageConfig {
  readonly workflowStageId: string;
  readonly workflowDefinitionId: string;
  readonly stageCode: string;
  readonly stageName: string;
  readonly sequenceNo: number;
  readonly assignmentType: string;
  readonly assignedUserId: string | null;
  readonly assignedWorkflowRoleId: string | null;
  readonly assignedTeamId: string | null;
  readonly approvalMode: ApprovalMode;
  readonly requiredApprovals: number;
  readonly terminalStage: boolean;
}

export async function getStageConfig(db: Client, stageId: string): Promise<StageConfig | null> {
  const result = await db.execute({
    sql: `SELECT workflow_stage_id, workflow_definition_id, stage_code, stage_name, sequence_no,
                 assignment_type, assigned_user_id, assigned_workflow_role_id, assigned_team_id,
                 approval_mode, required_approvals, terminal_stage
          FROM workflow_stages WHERE workflow_stage_id = ? LIMIT 1`,
    args: [stageId],
  });
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    workflowStageId: text(row.workflow_stage_id),
    workflowDefinitionId: text(row.workflow_definition_id),
    stageCode: text(row.stage_code),
    stageName: text(row.stage_name),
    sequenceNo: Number(row.sequence_no ?? 1),
    assignmentType: text(row.assignment_type),
    assignedUserId: nullableText(row.assigned_user_id),
    assignedWorkflowRoleId: nullableText(row.assigned_workflow_role_id),
    assignedTeamId: nullableText(row.assigned_team_id),
    approvalMode: text(row.approval_mode) as ApprovalMode,
    requiredApprovals: Number(row.required_approvals ?? 1),
    terminalStage: Number(row.terminal_stage ?? 0) === 1,
  };
}

/**
 * How many approvals complete this stage.
 *
 * `approval_mode` and `required_approvals` are two columns and they interact,
 * so the interaction is decided once, here, rather than at each decision:
 *
 *   ANY_ONE    max(1, required_approvals). A value above one means "any two of
 *              them", which is a real configuration and worth honouring rather
 *              than silently clamping to one.
 *   ALL        every required assignee, and `required_approvals` is recorded
 *              but not a second gate. A value below the assignee count would
 *              complete the stage while a required assignee still had it open,
 *              which contradicts the mode; a value above is unsatisfiable.
 *              The administration screen says so where the two disagree.
 *   SEQUENTIAL every required assignee, in `sequence_no` order, and only the
 *              lowest outstanding sequence may act.
 *   ROUND_ROBIN exactly one assignee is persisted, so exactly one approval.
 *   NAMED      exactly one assignee, the configured user.
 *   SYSTEM     nobody, and the stage completes with no human decision.
 */
export function approvalThreshold(
  mode: ApprovalMode,
  requiredApprovals: number,
  requiredAssignees: number,
): number {
  switch (mode) {
    case 'ANY_ONE':
      return Math.max(1, requiredApprovals);
    case 'ALL':
    case 'SEQUENTIAL':
      return requiredAssignees;
    case 'ROUND_ROBIN':
    case 'NAMED':
      return Math.min(1, requiredAssignees);
    case 'SYSTEM':
      return 0;
  }
}

export interface AssigneeRow {
  readonly assigneeId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly workflowRoleAssignmentId: string | null;
  readonly sequenceNo: number;
  readonly required: boolean;
  readonly status: StageStatus;
  readonly assignedAt: string;
  readonly actedAt: string | null;
  readonly decision: string | null;
  readonly notes: string | null;
}

export async function listAssignees(db: Client, stageInstanceId: string): Promise<AssigneeRow[]> {
  const result = await db.execute({
    sql: `SELECT a.workflow_stage_assignee_id, a.user_id, a.workflow_role_assignment_id,
                 a.sequence_no, a.required, a.status, a.assigned_at, a.acted_at,
                 a.decision, a.notes, u.display_name
          FROM workflow_stage_assignees a
          JOIN users u ON u.user_id = a.user_id
          WHERE a.workflow_stage_instance_id = ?
          ORDER BY a.sequence_no, a.workflow_stage_assignee_id`,
    args: [stageInstanceId],
  });
  return result.rows.map((row) => ({
    assigneeId: text(row.workflow_stage_assignee_id),
    userId: text(row.user_id),
    displayName: text(row.display_name),
    workflowRoleAssignmentId: nullableText(row.workflow_role_assignment_id),
    sequenceNo: Number(row.sequence_no ?? 1),
    required: Number(row.required ?? 1) === 1,
    status: text(row.status) as StageStatus,
    assignedAt: text(row.assigned_at),
    actedAt: nullableText(row.acted_at),
    decision: nullableText(row.decision),
    notes: nullableText(row.notes),
  }));
}

export interface StageInstanceRow {
  readonly stageInstanceId: string;
  readonly workflowInstanceId: string;
  readonly workflowStageId: string;
  readonly status: StageStatus;
  readonly assignedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly actionNotes: string | null;
}

export async function getStageInstance(
  db: Client,
  stageInstanceId: string,
): Promise<StageInstanceRow | null> {
  const result = await db.execute({
    sql: `SELECT workflow_stage_instance_id, workflow_instance_id, workflow_stage_id, status,
                 assigned_at, started_at, completed_at, action_notes
          FROM workflow_stage_instances WHERE workflow_stage_instance_id = ? LIMIT 1`,
    args: [stageInstanceId],
  });
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    stageInstanceId: text(row.workflow_stage_instance_id),
    workflowInstanceId: text(row.workflow_instance_id),
    workflowStageId: text(row.workflow_stage_id),
    status: text(row.status) as StageStatus,
    assignedAt: nullableText(row.assigned_at),
    startedAt: nullableText(row.started_at),
    completedAt: nullableText(row.completed_at),
    actionNotes: nullableText(row.action_notes),
  };
}

/**
 * ROUND_ROBIN, made fair and deterministic.
 *
 * The eligible approver who has been assigned this particular stage fewest
 * times before takes it, with the assignment id breaking a tie. Counting prior
 * assignments of the same `workflow_stage_id` rather than a global counter
 * keeps the rotation inside the stage it belongs to, and there is nowhere in
 * the schema to hold a cursor, so the history is the cursor.
 */
async function pickRoundRobin(
  db: Client,
  stageId: string,
  approvers: readonly ApproverMatch[],
): Promise<ApproverMatch | undefined> {
  const ids = approvers.map((approver) => approver.userId);
  if (ids.length === 0) return undefined;
  const placeholders = ids.map(() => '?').join(', ');
  const counts = await db.execute({
    sql: `SELECT a.user_id, COUNT(*) AS taken
          FROM workflow_stage_assignees a
          JOIN workflow_stage_instances si
            ON si.workflow_stage_instance_id = a.workflow_stage_instance_id
          WHERE si.workflow_stage_id = ? AND a.user_id IN (${placeholders})
          GROUP BY a.user_id`,
    args: [stageId, ...ids],
  });
  const taken = new Map<string, number>();
  for (const row of counts.rows) taken.set(text(row.user_id), Number(row.taken ?? 0));
  return [...approvers].sort((a, b) => {
    const left = taken.get(a.userId) ?? 0;
    const right = taken.get(b.userId) ?? 0;
    return left - right || a.assignmentId.localeCompare(b.assignmentId);
  })[0];
}

export type AssignOutcome =
  | {
      readonly ok: true;
      readonly stageInstanceId: string;
      readonly assignees: readonly AssigneeRow[];
      readonly resolution: Resolution | null;
      readonly threshold: number;
      readonly alreadyAssigned: boolean;
    }
  | {
      readonly ok: false;
      readonly kind: 'exception';
      readonly stageInstanceId: string;
      readonly resolution: Resolution;
    }
  | { readonly ok: false; readonly kind: 'not_found' };

/**
 * Who this stage's approvers are, resolved for the first and only time.
 *
 * The four assignment types are separate paths because they answer the question
 * from different places, and only one of them consults authority:
 *   WORKFLOW_ROLE  the resolver, with the transaction context
 *   USER / NAMED   the configured user, with no authority test: naming a person
 *                  on the stage *is* the authority statement
 *   TEAM           the team's live members
 *   SYSTEM         nobody
 */
async function resolveStageApprovers(
  db: Client,
  stage: StageConfig,
  context: TransactionContext,
): Promise<{ approvers: ApproverMatch[]; resolution: Resolution | null }> {
  if (stage.assignmentType === 'SYSTEM' || stage.approvalMode === 'SYSTEM') {
    return { approvers: [], resolution: null };
  }

  if (stage.assignmentType === 'USER') {
    if (stage.assignedUserId === null) return { approvers: [], resolution: null };
    const result = await db.execute({
      sql: `SELECT user_id, display_name FROM users
            WHERE user_id = ? AND status = 'ACTIVE' LIMIT 1`,
      args: [stage.assignedUserId],
    });
    const row = result.rows[0];
    if (row === undefined) return { approvers: [], resolution: null };
    return {
      approvers: [
        {
          userId: text(row.user_id),
          displayName: text(row.display_name),
          assignmentId: '',
          scopeType: 'GROUP',
          scopeTargetId: null,
          priority: 0,
          ruleId: null,
          rulePriority: null,
          unrestricted: true,
          reason: `${text(row.display_name)} is named on stage ${stage.stageCode}.`,
        },
      ],
      resolution: null,
    };
  }

  if (stage.assignmentType === 'TEAM') {
    if (stage.assignedTeamId === null) return { approvers: [], resolution: null };
    const result = await db.execute({
      sql: `SELECT u.user_id, u.display_name
            FROM team_members tm
            JOIN users u ON u.user_id = tm.user_id
            WHERE tm.team_id = ? AND u.status = 'ACTIVE' AND tm.active = 1
              AND tm.effective_from <= ?
              AND (tm.effective_to IS NULL OR tm.effective_to >= ?)
            ORDER BY u.user_id`,
      args: [stage.assignedTeamId, context.eventDate, context.eventDate],
    });
    return {
      approvers: result.rows.map((row) => ({
        userId: text(row.user_id),
        displayName: text(row.display_name),
        assignmentId: '',
        scopeType: 'GROUP' as const,
        scopeTargetId: null,
        priority: 0,
        ruleId: null,
        rulePriority: null,
        unrestricted: true,
        reason: `A live member of the team configured on stage ${stage.stageCode}.`,
      })),
      resolution: null,
    };
  }

  if (stage.assignedWorkflowRoleId === null) return { approvers: [], resolution: null };
  const resolution = await resolveApprovers(db, {
    processType: context.processType,
    workflowRoleId: stage.assignedWorkflowRoleId,
    countryId: context.countryId,
    affiliateId: context.affiliateId,
    businessUnitId: context.businessUnitId,
    amount: context.amount,
    currencyCode: context.currencyCode,
    lines: context.lines,
    eventDate: context.eventDate,
  });
  return {
    approvers: resolution.outcome === 'resolved' ? [...resolution.approvers] : [],
    resolution,
  };
}

/**
 * Create a stage instance and write its assignees, once.
 *
 * Idempotent by construction: if the stage instance already has assignees, they
 * are returned unchanged and nothing is resolved. `UNIQUE(stage_instance,
 * user)` makes that safe even under a concurrent second call.
 *
 * When nobody is eligible the stage is created anyway, in `PENDING`, with no
 * assignees and an `APPROVAL_EXCEPTION` audit row naming the process, the
 * entity, the workflow role and the organisational context. It stays visible
 * and unresolved. It does not fall back to a random user and it does not fall
 * back to the system administrator.
 */
export async function assignStage(
  db: Client,
  input: {
    readonly workflowInstanceId: string;
    readonly workflowStageId: string;
    readonly context: TransactionContext;
  },
  ctx: WriteContext,
): Promise<AssignOutcome> {
  const stage = await getStageConfig(db, input.workflowStageId);
  if (stage === null) return { ok: false, kind: 'not_found' };

  const instance = await db.execute({
    sql: `SELECT workflow_instance_id, entity_type, entity_id FROM workflow_instances
          WHERE workflow_instance_id = ? LIMIT 1`,
    args: [input.workflowInstanceId],
  });
  const instanceRow = instance.rows[0];
  if (instanceRow === undefined) return { ok: false, kind: 'not_found' };

  // An existing stage instance for this stage keeps whatever it already has.
  const existing = await db.execute({
    sql: `SELECT workflow_stage_instance_id FROM workflow_stage_instances
          WHERE workflow_instance_id = ? AND workflow_stage_id = ? LIMIT 1`,
    args: [input.workflowInstanceId, input.workflowStageId],
  });
  const existingRow = existing.rows[0];
  if (existingRow !== undefined) {
    const stageInstanceId = text(existingRow.workflow_stage_instance_id);
    const assignees = await listAssignees(db, stageInstanceId);
    return {
      ok: true,
      stageInstanceId,
      assignees,
      resolution: null,
      threshold: approvalThreshold(
        stage.approvalMode,
        stage.requiredApprovals,
        assignees.filter((a) => a.required).length,
      ),
      alreadyAssigned: true,
    };
  }

  const { approvers, resolution } = await resolveStageApprovers(db, stage, input.context);
  const chosen =
    stage.approvalMode === 'ROUND_ROBIN'
      ? await pickRoundRobin(db, stage.workflowStageId, approvers).then((one) =>
          one === undefined ? [] : [one],
        )
      : stage.approvalMode === 'NAMED'
        ? approvers.slice(0, 1)
        : approvers;

  const stageInstanceId = newId('WSI');
  const now = toDbTimestamp(ctx.now);
  const systemStage = stage.assignmentType === 'SYSTEM' || stage.approvalMode === 'SYSTEM';
  const exception = !systemStage && chosen.length === 0;
  const status: StageStatus = exception ? 'PENDING' : systemStage ? 'COMPLETED' : 'ACTIVE';

  const statements: Stmt[] = [
    {
      sql: `INSERT INTO workflow_stage_instances
              (workflow_stage_instance_id, workflow_instance_id, workflow_stage_id,
               assigned_user_id, assigned_team_id, status, assigned_at, started_at,
               completed_at, action_notes)
            VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
      args: [
        stageInstanceId,
        input.workflowInstanceId,
        input.workflowStageId,
        stage.assignedTeamId,
        status,
        exception ? null : now,
        exception ? null : now,
        systemStage ? now : null,
        exception ? 'Configuration exception: no eligible approver.' : null,
      ],
    },
  ];

  chosen.forEach((approver, index) => {
    statements.push({
      sql: `INSERT INTO workflow_stage_assignees
              (workflow_stage_assignee_id, workflow_stage_instance_id, user_id,
               workflow_role_assignment_id, sequence_no, required, status, assigned_at,
               acted_at, decision, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      args: [
        newId('WSA'),
        stageInstanceId,
        approver.userId,
        approver.assignmentId === '' ? null : approver.assignmentId,
        index + 1,
        // ANY_ONE offers the stage to everyone eligible and requires a
        // threshold of them, so no single person is required. Every other mode
        // needs each assignee, so each is.
        stage.approvalMode === 'ANY_ONE' ? 0 : 1,
        // SEQUENTIAL activates only the first; the rest wait their turn.
        stage.approvalMode === 'SEQUENTIAL' && index > 0 ? 'PENDING' : 'ACTIVE',
        now,
        approver.reason,
      ],
    });
  });

  if (exception) {
    statements.push(
      audit(
        ctx,
        WORKFLOW_AUDIT.approvalException,
        'WORKFLOW_STAGE_INSTANCE',
        stageInstanceId,
        'RESOLVE',
        null,
        {
          processType: input.context.processType,
          entityType: text(instanceRow.entity_type),
          entityId: text(instanceRow.entity_id),
          workflowStageId: stage.workflowStageId,
          stageCode: stage.stageCode,
          requiredWorkflowRoleId: stage.assignedWorkflowRoleId,
          countryId: input.context.countryId,
          affiliateId: input.context.affiliateId,
          businessUnitId: input.context.businessUnitId,
          amount: input.context.amount,
          currencyCode: input.context.currencyCode,
          reason: resolution?.outcome === 'exception' ? resolution.reason : 'no_eligible_approver',
        },
      ),
    );
  } else {
    statements.push(
      audit(
        ctx,
        WORKFLOW_AUDIT.approverResolved,
        'WORKFLOW_STAGE_INSTANCE',
        stageInstanceId,
        'RESOLVE',
        null,
        {
          processType: input.context.processType,
          entityType: text(instanceRow.entity_type),
          entityId: text(instanceRow.entity_id),
          workflowStageId: stage.workflowStageId,
          stageCode: stage.stageCode,
          approvalMode: stage.approvalMode,
          context: {
            countryId: input.context.countryId,
            affiliateId: input.context.affiliateId,
            businessUnitId: input.context.businessUnitId,
            amount: input.context.amount,
            currencyCode: input.context.currencyCode,
            eventDate: input.context.eventDate,
          },
          assignees: chosen.map((approver) => ({
            userId: approver.userId,
            workflowRoleAssignmentId: approver.assignmentId === '' ? null : approver.assignmentId,
            authorityRuleId: approver.ruleId,
            scopeType: approver.scopeType,
            unrestricted: approver.unrestricted,
          })),
        },
      ),
    );
  }

  await db.batch(statements, 'write');

  if (exception && resolution !== null) {
    return { ok: false, kind: 'exception', stageInstanceId, resolution };
  }
  const assignees = await listAssignees(db, stageInstanceId);
  return {
    ok: true,
    stageInstanceId,
    assignees,
    resolution,
    threshold: approvalThreshold(
      stage.approvalMode,
      stage.requiredApprovals,
      assignees.filter((a) => a.required).length,
    ),
    alreadyAssigned: false,
  };
}

export type DecisionRefusal =
  | 'not_found'
  | 'stage_not_active'
  | 'not_an_assignee'
  | 'already_acted'
  | 'not_your_turn';

export type DecisionOutcome =
  | {
      readonly ok: true;
      readonly stageStatus: StageStatus;
      readonly approvals: number;
      readonly threshold: number;
      readonly assignees: readonly AssigneeRow[];
    }
  | { readonly ok: false; readonly kind: DecisionRefusal };

/**
 * Record one person's decision on one stage.
 *
 * `actorUserId` comes from `ctx`, which the endpoint built from the session.
 * There is no parameter naming the approver, so no request body can name one:
 * posting somebody else's id changes nothing, because nothing reads it.
 *
 * Every check is made here and none is trusted to the caller: the stage exists,
 * it is ACTIVE, this principal is an assignee of it, they have not already
 * acted, and for SEQUENTIAL it is their turn.
 */
export async function recordDecision(
  db: Client,
  stageInstanceId: string,
  input: { readonly decision: 'APPROVED' | 'REJECTED'; readonly notes: string | null },
  ctx: WriteContext,
): Promise<DecisionOutcome> {
  const instance = await getStageInstance(db, stageInstanceId);
  if (instance === null) return { ok: false, kind: 'not_found' };
  if (instance.status !== 'ACTIVE') return { ok: false, kind: 'stage_not_active' };

  const stage = await getStageConfig(db, instance.workflowStageId);
  if (stage === null) return { ok: false, kind: 'not_found' };

  const assignees = await listAssignees(db, stageInstanceId);
  const mine = assignees.find((assignee) => assignee.userId === ctx.actorUserId);
  if (mine === undefined) return { ok: false, kind: 'not_an_assignee' };
  if (mine.actedAt !== null) return { ok: false, kind: 'already_acted' };

  if (stage.approvalMode === 'SEQUENTIAL') {
    const outstanding = assignees
      .filter((assignee) => assignee.actedAt === null)
      .sort((a, b) => a.sequenceNo - b.sequenceNo)[0];
    if (outstanding === undefined || outstanding.assigneeId !== mine.assigneeId) {
      return { ok: false, kind: 'not_your_turn' };
    }
  }

  const now = toDbTimestamp(ctx.now);
  const approvalsAfter =
    assignees.filter((assignee) => assignee.decision === 'APPROVED').length +
    (input.decision === 'APPROVED' ? 1 : 0);
  const requiredCount = assignees.filter((assignee) => assignee.required).length;
  const threshold = approvalThreshold(stage.approvalMode, stage.requiredApprovals, requiredCount);

  // One rejection ends the stage. Waiting for the remaining approvers on a
  // stage that has already been refused asks people to rubber-stamp a decision
  // that cannot change.
  const stageStatus: StageStatus =
    input.decision === 'REJECTED'
      ? 'REJECTED'
      : approvalsAfter >= threshold
        ? 'APPROVED'
        : 'ACTIVE';

  const statements: Stmt[] = [
    {
      sql: `UPDATE workflow_stage_assignees
            SET status = ?, decision = ?, acted_at = ?, notes = ?
            WHERE workflow_stage_assignee_id = ?`,
      args: [input.decision, input.decision, now, input.notes, mine.assigneeId],
    },
  ];

  if (stageStatus !== 'ACTIVE') {
    statements.push({
      sql: `UPDATE workflow_stage_instances
            SET status = ?, completed_at = ? WHERE workflow_stage_instance_id = ?`,
      args: [stageStatus, now, stageInstanceId],
    });
    // Everyone still waiting on a stage that has concluded is closed out, so no
    // approver is left with an open item they can no longer act on.
    statements.push({
      sql: `UPDATE workflow_stage_assignees
            SET status = 'SKIPPED'
            WHERE workflow_stage_instance_id = ? AND acted_at IS NULL`,
      args: [stageInstanceId],
    });
  } else if (stage.approvalMode === 'SEQUENTIAL') {
    // Hand the stage to the next in sequence.
    statements.push({
      sql: `UPDATE workflow_stage_assignees
            SET status = 'ACTIVE'
            WHERE workflow_stage_assignee_id = (
              SELECT workflow_stage_assignee_id FROM workflow_stage_assignees
              WHERE workflow_stage_instance_id = ? AND acted_at IS NULL
                AND workflow_stage_assignee_id <> ?
              ORDER BY sequence_no LIMIT 1)`,
      args: [stageInstanceId, mine.assigneeId],
    });
  }

  statements.push(
    audit(
      ctx,
      input.decision === 'APPROVED'
        ? WORKFLOW_AUDIT.approvalCompleted
        : WORKFLOW_AUDIT.approvalRejected,
      'WORKFLOW_STAGE_INSTANCE',
      stageInstanceId,
      input.decision,
      {
        stageStatus: instance.status,
        approvals: approvalsAfter - (input.decision === 'APPROVED' ? 1 : 0),
      },
      {
        stageStatus,
        approvals: approvalsAfter,
        threshold,
        approvalMode: stage.approvalMode,
        workflowRoleAssignmentId: mine.workflowRoleAssignmentId,
      },
    ),
  );

  await db.batch(statements, 'write');
  return {
    ok: true,
    stageStatus,
    approvals: approvalsAfter,
    threshold,
    assignees: await listAssignees(db, stageInstanceId),
  };
}

export type ReResolveOutcome =
  | {
      readonly ok: true;
      readonly assignees: readonly AssigneeRow[];
      readonly resolution: Resolution | null;
    }
  | {
      readonly ok: false;
      readonly kind: 'not_found' | 'stage_concluded' | 'exception';
      readonly resolution?: Resolution;
    };

/**
 * Re-resolve a started stage, deliberately.
 *
 * The administrator asks for this; nothing does it implicitly and no read path
 * calls it. Assignees who have already acted keep their rows and their
 * decisions: a recorded decision is a fact, and dropping it because the
 * configuration moved would erase evidence. Everyone still outstanding is
 * replaced by the current resolution.
 */
export async function reResolveStage(
  db: Client,
  stageInstanceId: string,
  context: TransactionContext,
  ctx: WriteContext,
): Promise<ReResolveOutcome> {
  const instance = await getStageInstance(db, stageInstanceId);
  if (instance === null) return { ok: false, kind: 'not_found' };
  if (
    instance.status === 'APPROVED' ||
    instance.status === 'REJECTED' ||
    instance.status === 'COMPLETED'
  ) {
    return { ok: false, kind: 'stage_concluded' };
  }
  const stage = await getStageConfig(db, instance.workflowStageId);
  if (stage === null) return { ok: false, kind: 'not_found' };

  const before = await listAssignees(db, stageInstanceId);
  const acted = before.filter((assignee) => assignee.actedAt !== null);
  const { approvers, resolution } = await resolveStageApprovers(db, stage, context);
  const keep = new Set(acted.map((assignee) => assignee.userId));
  const fresh = approvers.filter((approver) => !keep.has(approver.userId));

  if (acted.length === 0 && fresh.length === 0) {
    return { ok: false, kind: 'exception', resolution: resolution ?? undefined };
  }

  const now = toDbTimestamp(ctx.now);
  const statements: Stmt[] = [
    {
      sql: `DELETE FROM workflow_stage_assignees
            WHERE workflow_stage_instance_id = ? AND acted_at IS NULL`,
      args: [stageInstanceId],
    },
  ];
  fresh.forEach((approver, index) => {
    statements.push({
      sql: `INSERT INTO workflow_stage_assignees
              (workflow_stage_assignee_id, workflow_stage_instance_id, user_id,
               workflow_role_assignment_id, sequence_no, required, status, assigned_at,
               acted_at, decision, notes)
            VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, NULL, NULL, ?)`,
      args: [
        newId('WSA'),
        stageInstanceId,
        approver.userId,
        approver.assignmentId === '' ? null : approver.assignmentId,
        acted.length + index + 1,
        stage.approvalMode === 'ANY_ONE' ? 0 : 1,
        now,
        approver.reason,
      ],
    });
  });
  statements.push({
    sql: `UPDATE workflow_stage_instances SET status = 'ACTIVE', assigned_at = ?, action_notes = NULL
          WHERE workflow_stage_instance_id = ?`,
    args: [now, stageInstanceId],
  });
  statements.push(
    audit(
      ctx,
      WORKFLOW_AUDIT.approverResolved,
      'WORKFLOW_STAGE_INSTANCE',
      stageInstanceId,
      'RE_RESOLVE',
      { assignees: before.map((assignee) => assignee.userId) },
      {
        assignees: [...acted.map((a) => a.userId), ...fresh.map((a) => a.userId)],
        context: {
          countryId: context.countryId,
          affiliateId: context.affiliateId,
          businessUnitId: context.businessUnitId,
          amount: context.amount,
          currencyCode: context.currencyCode,
          eventDate: context.eventDate,
        },
      },
    ),
  );

  await db.batch(statements, 'write');
  return { ok: true, assignees: await listAssignees(db, stageInstanceId), resolution };
}

/**
 * Start a workflow for an entity: the instance, then its first stage.
 *
 * The definition is chosen by the caller and recorded on the instance. Version
 * selection is `pickDefinition` in ../repos/workflowAdmin.ts, and once the
 * instance holds an id, that version is what this record means for ever: the
 * foreign key is ON DELETE RESTRICT, and nothing here rewrites it when a later
 * version appears.
 */
export async function startWorkflow(
  db: Client,
  input: {
    readonly workflowDefinitionId: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly context: TransactionContext;
  },
  ctx: WriteContext,
): Promise<{ workflowInstanceId: string; first: AssignOutcome } | null> {
  const stages = await db.execute({
    sql: `SELECT workflow_stage_id FROM workflow_stages
          WHERE workflow_definition_id = ? ORDER BY sequence_no LIMIT 1`,
    args: [input.workflowDefinitionId],
  });
  const firstStage = stages.rows[0];
  if (firstStage === undefined) return null;

  const workflowInstanceId = newId('WFI');
  await db.execute({
    sql: `INSERT INTO workflow_instances
            (workflow_instance_id, workflow_definition_id, entity_type, entity_id, status,
             started_at, completed_at, current_stage_id, created_at)
          VALUES (?, ?, ?, ?, 'IN_PROGRESS', ?, NULL, ?, ?)`,
    args: [
      workflowInstanceId,
      input.workflowDefinitionId,
      input.entityType,
      input.entityId,
      toDbTimestamp(ctx.now),
      text(firstStage.workflow_stage_id),
      toDbTimestamp(ctx.now),
    ],
  });

  const first = await assignStage(
    db,
    {
      workflowInstanceId,
      workflowStageId: text(firstStage.workflow_stage_id),
      context: input.context,
    },
    ctx,
  );
  return { workflowInstanceId, first };
}

/** The version an instance was created under, read back for section 19. */
export async function instanceVersion(
  db: Client,
  workflowInstanceId: string,
): Promise<{ workflowDefinitionId: string; workflowName: string; versionNo: number } | null> {
  const result = await db.execute({
    sql: `SELECT d.workflow_definition_id, d.workflow_name, d.version_no
          FROM workflow_instances i
          JOIN workflow_definitions d ON d.workflow_definition_id = i.workflow_definition_id
          WHERE i.workflow_instance_id = ? LIMIT 1`,
    args: [workflowInstanceId],
  });
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    workflowDefinitionId: text(row.workflow_definition_id),
    workflowName: text(row.workflow_name),
    versionNo: Number(row.version_no ?? 1),
  };
}

export { nullableNumber as parseNullableNumber };
