/**
 * The action-plan transition and delegation executor. Every status change runs
 * through executeTransition, so the ported remediation workflow is enforced in
 * one place, never hard-coded:
 *
 *  1. the action's permission (for an auditor or HOA action) and, for an owner
 *     action, that the actor is an owner;
 *  2. the foundation engine's validation against status_transitions (allowed,
 *     required_role, requires_comment, not terminal);
 *  3. the evidence gate on mark-as-implemented;
 *  4. then, atomically, the status, the per-action effect (implementation notes
 *     and date, or the auditor or HOA review), an append-only
 *     action_plan_history row and an audit_log row;
 *  5. and a notification on the right events.
 *
 * Delegation and the delegation decision are separate operations (they change
 * owners, not status), each with their own history, audit and notification.
 */
import type { Client, InStatement } from '@libsql/client/web';
import {
  checkTransition,
  loadTransitions,
  loadTerminalStates,
  type TransitionRule,
} from './transitions';
import { ACTION_PLAN_ENUM_TYPE, actionForTransition } from './actionPlanActions';
import { getActionPlan } from '@grc/repos/actionPlans';
import { isOwner, parseOwnerIds, setOwners, type OwnerRef } from '@grc/repos/actionPlanOwners';
import { insertHistoryStatement } from '@grc/repos/actionPlanHistory';
import { enqueueNotification } from '@grc/repos/notify';
import { buildAuditStatement } from '@grc/repos/audit';

export interface Actor {
  userId: string;
  userName: string;
  roleCode: string;
  isPlatformOwner: boolean;
  perms: string[];
}

export type Result =
  | { ok: true; from: string; to: string }
  | { ok: false; code: string; message: string };

const EVIDENCE_OVERRIDE = 'ACTION_PLANS.evidence_override';

// The organisation scope lives on files, not on the file_attachments link table
// (which has no organization_id of its own), so the count joins through it.
async function evidenceCount(db: Client, organizationId: string, id: string): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n
            FROM file_attachments fa
            JOIN files f ON f.file_id = fa.file_id
           WHERE f.organization_id = ? AND f.deleted_at IS NULL
             AND fa.entity_type = 'action_plan' AND fa.entity_id = ?`,
    args: [organizationId, id],
  });
  return Number(res.rows[0]?.n ?? 0);
}

export interface TransitionExtras {
  comment: string | null;
  /** Implementation notes, for the mark-as-implemented action. */
  implementationNotes?: string | null;
}

export async function executeTransition(
  db: Client,
  organizationId: string,
  id: string,
  toStatus: string,
  actor: Actor,
  extras: TransitionExtras,
): Promise<Result> {
  const plan = await getActionPlan(db, organizationId, id);
  if (!plan) return { ok: false, code: 'not_found', message: 'That action plan was not found.' };
  const from = plan.status;

  const meta = actionForTransition(from, toStatus);
  if (!meta) return { ok: false, code: 'unknown_action', message: 'That action is not available.' };

  // The permission (auditor or HOA action) and the owner check (owner action).
  if (meta.permission && !actor.perms.includes(meta.permission)) {
    return { ok: false, code: 'forbidden', message: 'You do not have permission for that action.' };
  }
  if (meta.ownerAction && !actor.isPlatformOwner && !isOwner(plan.ownerIds, actor.userId)) {
    return { ok: false, code: 'forbidden', message: 'Only an owner of this plan may do that.' };
  }

  // The engine validates the transition (required_role, requires_comment).
  const outcome = await checkTransition(db, ACTION_PLAN_ENUM_TYPE, {
    from,
    to: toStatus,
    roleCode: actor.roleCode,
    isPlatformOwner: actor.isPlatformOwner,
    comment: extras.comment,
  });
  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };

  // Evidence gate on mark-as-implemented.
  if (meta.requiresEvidence && !actor.perms.includes(EVIDENCE_OVERRIDE)) {
    if ((await evidenceCount(db, organizationId, id)) === 0) {
      return {
        ok: false,
        code: 'evidence_required',
        message: 'Attach evidence before marking this plan as implemented.',
      };
    }
  }

  const now = new Date().toISOString();
  const sets = ['status = ?', 'updated_at = ?'];
  const args: (string | number | null)[] = [toStatus, now];

  if (meta.effect === 'implement') {
    sets.push('implementation_notes = ?', 'implemented_date = ?');
    args.push(extras.implementationNotes ?? null, now);
  } else if (meta.effect === 'auditor_review') {
    sets.push('auditor_review_comments = ?', 'auditor_review_by = ?', 'auditor_review_date = ?');
    args.push(extras.comment, actor.userId, now);
  } else if (meta.effect === 'hoa_review') {
    sets.push('hoa_review_comments = ?', 'hoa_review_by = ?', 'hoa_review_date = ?');
    args.push(extras.comment, actor.userId, now);
  }
  args.push(id, organizationId);

  const statements: InStatement[] = [
    {
      sql: `UPDATE action_plans SET ${sets.join(', ')} WHERE action_plan_id = ? AND organization_id = ?`,
      args,
    },
    insertHistoryStatement({
      actionPlanId: id,
      previousStatus: from,
      newStatus: toStatus,
      comments: extras.comment,
      userId: actor.userId,
      userName: actor.userName,
    }),
    auditStatement(
      organizationId,
      actor.userId,
      'ACTION_PLAN.transition',
      `${id}: ${from} -> ${toStatus}`,
    ),
  ];
  await db.batch(statements, 'write');

  if (meta.notifyTemplate) {
    await enqueueNotification(db, {
      organizationId,
      templateCode: meta.notifyTemplate,
      entityType: 'action_plan',
      entityId: id,
      actorUserId: actor.userId,
    });
  }
  return { ok: true, from, to: toStatus };
}

/**
 * Delegate a plan to a new owner. The actor must be an owner and the plan
 * non-terminal. Records the delegation attribution, preserves the original
 * owners, and swaps the current owners to the new owner through setOwners.
 */
export async function delegate(
  db: Client,
  organizationId: string,
  id: string,
  actor: Actor,
  newOwner: OwnerRef,
  notes: string | null,
): Promise<Result> {
  const plan = await getActionPlan(db, organizationId, id);
  if (!plan) return { ok: false, code: 'not_found', message: 'That action plan was not found.' };
  if (!actor.isPlatformOwner && !isOwner(plan.ownerIds, actor.userId)) {
    return { ok: false, code: 'forbidden', message: 'Only an owner may delegate this plan.' };
  }
  const from = plan.status;
  const now = new Date().toISOString();
  const originalOwners =
    plan.original_owner_ids == null ? plan.ownerIds : String(plan.original_owner_ids);

  await db.execute({
    sql: `UPDATE action_plans
             SET delegated_by_id = ?, delegated_by_name = ?, delegated_date = ?, delegation_notes = ?,
                 original_owner_ids = ?, delegation_accepted_date = NULL, updated_at = ?
           WHERE action_plan_id = ? AND organization_id = ?`,
    args: [actor.userId, actor.userName, now, notes, originalOwners, now, id, organizationId],
  });
  await setOwners(db, organizationId, id, [newOwner]);
  await db.batch(
    [
      insertHistoryStatement({
        actionPlanId: id,
        previousStatus: from,
        newStatus: from,
        comments: `Delegated to ${newOwner.name}${notes ? `: ${notes}` : ''}`,
        userId: actor.userId,
        userName: actor.userName,
      }),
      auditStatement(
        organizationId,
        actor.userId,
        'ACTION_PLAN.delegate',
        `${id} -> ${newOwner.userId}`,
      ),
    ],
    'write',
  );
  await enqueueNotification(db, {
    organizationId,
    templateCode: 'action_delegated',
    entityType: 'action_plan',
    entityId: id,
    actorUserId: actor.userId,
  });
  return { ok: true, from, to: from };
}

/**
 * The new owner accepts or rejects a delegation. Reject reverts the owners to the
 * originals and records the reason; both write history.
 */
export async function decideDelegation(
  db: Client,
  organizationId: string,
  id: string,
  actor: Actor,
  accept: boolean,
  reason: string | null,
  originalOwners: OwnerRef[],
): Promise<Result> {
  const plan = await getActionPlan(db, organizationId, id);
  if (!plan) return { ok: false, code: 'not_found', message: 'That action plan was not found.' };
  if (!actor.isPlatformOwner && !isOwner(plan.ownerIds, actor.userId)) {
    return { ok: false, code: 'forbidden', message: 'Only the delegated owner may decide this.' };
  }
  const from = plan.status;
  const now = new Date().toISOString();
  if (accept) {
    // Record the acceptance so the decision prompt no longer shows.
    await db.execute({
      sql: `UPDATE action_plans SET delegation_accepted_date = ?, updated_at = ?
             WHERE action_plan_id = ? AND organization_id = ?`,
      args: [now, now, id, organizationId],
    });
  } else {
    // Revert to the original owners and clear the delegation.
    const revertTo =
      originalOwners.length > 0
        ? originalOwners
        : parseOwnerIds(
            plan.original_owner_ids == null ? null : String(plan.original_owner_ids),
          ).map((uid) => ({ userId: uid, name: uid }));
    await setOwners(db, organizationId, id, revertTo);
    await db.execute({
      sql: `UPDATE action_plans
               SET delegated_by_id = NULL, delegated_by_name = NULL, delegated_date = NULL,
                   delegation_notes = NULL, delegation_accepted_date = NULL, updated_at = ?
             WHERE action_plan_id = ? AND organization_id = ?`,
      args: [now, id, organizationId],
    });
  }
  await db.batch(
    [
      insertHistoryStatement({
        actionPlanId: id,
        previousStatus: from,
        newStatus: from,
        comments: accept
          ? 'Delegation accepted'
          : `Delegation rejected${reason ? `: ${reason}` : ''}`,
        userId: actor.userId,
        userName: actor.userName,
      }),
      auditStatement(
        organizationId,
        actor.userId,
        accept ? 'ACTION_PLAN.delegation_accept' : 'ACTION_PLAN.delegation_reject',
        id,
      ),
    ],
    'write',
  );
  return { ok: true, from, to: from };
}

/** The workflow actions offered from the current status: the engine's allowed moves the actor may make. */
export interface OfferedAction {
  toStatus: string;
  label: string;
  requiresComment: boolean;
  effect: string;
}

/**
 * The offered actions from already-loaded transition rules, so a list can work
 * out every row's moves from one pair of reads rather than one pair per row.
 * Pure, and the same filter the async form applies; both are only an
 * affordance, since executeTransition re-validates every move server-side.
 */
export function offeredActionsFrom(
  transitions: TransitionRule[],
  terminals: string[],
  plan: { status: string; ownerIds: string | null },
  actor: Actor,
): OfferedAction[] {
  if (terminals.includes(plan.status)) return [];
  const out: OfferedAction[] = [];
  for (const t of transitions) {
    if (t.fromStatus !== plan.status) continue;
    if (t.requiredRole && !actor.isPlatformOwner && t.requiredRole !== actor.roleCode) continue;
    const meta = actionForTransition(t.fromStatus, t.toStatus);
    if (!meta) continue;
    if (meta.permission && !actor.perms.includes(meta.permission)) continue;
    if (meta.ownerAction && !actor.isPlatformOwner && !isOwner(plan.ownerIds, actor.userId))
      continue;
    out.push({
      toStatus: t.toStatus,
      label: meta.label,
      requiresComment: t.requiresComment,
      effect: meta.effect,
    });
  }
  return out;
}

export async function offeredActions(
  db: Client,
  plan: { status: string; ownerIds: string | null },
  actor: Actor,
): Promise<OfferedAction[]> {
  const [transitions, terminals] = await Promise.all([
    loadTransitions(db, ACTION_PLAN_ENUM_TYPE),
    loadTerminalStates(db, ACTION_PLAN_ENUM_TYPE),
  ]);
  return offeredActionsFrom(transitions, terminals, plan, actor);
}

function auditStatement(
  organizationId: string,
  userId: string,
  action: string,
  details: string,
): InStatement {
  return buildAuditStatement({
    organizationId,
    userId,
    action,
    entityType: 'action_plan',
    details,
  });
}
