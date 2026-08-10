/**
 * The work-paper transition executor. Every status change runs through here, so
 * the ported lifecycle is enforced in one place, never hard-coded:
 *
 *  1. the target's WORK_PAPERS.* permission is required (from the action
 *     catalogue), on top of
 *  2. the foundation engine's validation of the transition against
 *     status_transitions (from -> to allowed, required_role held, requires_comment
 *     satisfied, not a terminal state);
 *  3. the SUPER_ADMIN evidence_override from the source: sending a finding to the
 *     auditee needs at least one piece of evidence, unless the actor may override;
 *  4. then, atomically, the status is set, revision_count incremented, the dated
 *     attribution stamped, an append-only work_paper_revisions row written, and an
 *     audit_log row recorded;
 *  5. and a notification is enqueued for submit, send and response events.
 *
 * A platform owner is exempt from the required_role (as in the engine) but the
 * WORK_PAPERS.* permission still applies through their permission set.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { checkTransition, loadTransitions, loadTerminalStates } from './transitions';
import { WORK_PAPER_ENUM_TYPE, WP_STATUS, actionForTarget, sameStatus } from './workPaperActions';
import { canMatrix, type PermissionMatrix } from '@grc/auth/matrix';
import { getWorkPaper } from '@grc/repos/workPapers';
import { insertRevisionStatement } from '@grc/repos/revisions';
import { enqueueNotification } from '@grc/repos/notify';
import { buildAuditStatement } from '@grc/repos/audit';
import { invalidateDashboard } from '@grc/cache/invalidate';

export interface TransitionActor {
  userId: string;
  userName: string;
  roleCode: string;
  isPlatformOwner: boolean;
  /**
   * The permission matrix the administrator edits on the access-control screen.
   * The workflow asks this directly (Build Prompt 55) rather than the derived
   * `WORK_PAPERS.*` list: one representation of a grant, so there is nothing to
   * fall out of step with what a reviewer sees ticked.
   */
  matrix: PermissionMatrix;
  perms: string[];
}

/** Whether the actor holds the matrix grant an action needs. */
function holdsGrant(actor: TransitionActor, meta: { grant: { module: string; action: string } }) {
  return canMatrix(actor.matrix, meta.grant.action, meta.grant.module);
}

export type TransitionResult =
  | { ok: true; fromStatus: string; toStatus: string }
  | {
      ok: false;
      code: 'not_found' | 'unknown_action' | 'forbidden' | 'evidence_required' | string;
      message: string;
    };

const EVIDENCE_OVERRIDE = 'WORK_PAPERS.evidence_override';

// The organisation scope lives on files, not on the file_attachments link table
// (which has no organization_id of its own), so the count joins through it.
async function evidenceCount(
  db: Client,
  organizationId: string,
  workPaperId: string,
): Promise<number> {
  const res = await db.execute({
    sql: `SELECT COUNT(*) AS n
            FROM file_attachments fa
            JOIN files f ON f.file_id = fa.file_id
           WHERE f.organization_id = ? AND f.deleted_at IS NULL
             AND fa.entity_type = 'work_paper' AND fa.entity_id = ?`,
    args: [organizationId, workPaperId],
  });
  return Number(res.rows[0]?.n ?? 0);
}

export async function executeTransition(
  db: Client,
  organizationId: string,
  workPaperId: string,
  toStatus: string,
  actor: TransitionActor,
  comment: string | null,
): Promise<TransitionResult> {
  const wp = await getWorkPaper(db, organizationId, workPaperId);
  if (!wp) return { ok: false, code: 'not_found', message: 'That work paper was not found.' };
  const fromStatus = wp.status;

  const meta = actionForTarget(toStatus);
  if (!meta) return { ok: false, code: 'unknown_action', message: 'Unknown workflow action.' };

  // The matrix grant for this action (a platform owner is not exempt from it;
  // their matrix carries what they may do).
  if (!holdsGrant(actor, meta)) {
    return { ok: false, code: 'forbidden', message: 'You do not have permission for that action.' };
  }

  // The engine validates the transition itself: allowed, required_role, comment.
  const outcome = await checkTransition(db, WORK_PAPER_ENUM_TYPE, {
    from: fromStatus,
    to: toStatus,
    roleCode: actor.roleCode,
    isPlatformOwner: actor.isPlatformOwner,
    comment,
  });
  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };

  // Evidence gate on sending to the auditee, with the SUPER_ADMIN override. It
  // guards the first share only: reopening a finding for another response round
  // is not a fresh disclosure, and the evidence it demanded was already attached
  // when the finding first went out.
  const alreadySent = wp.sent_to_auditee_date != null;
  if (toStatus === WP_STATUS.SENT_TO_AUDITEE && !alreadySent) {
    const mayOverride = actor.perms.includes(EVIDENCE_OVERRIDE);
    if (!mayOverride && (await evidenceCount(db, organizationId, workPaperId)) === 0) {
      return {
        ok: false,
        code: 'evidence_required',
        message: 'Attach evidence before sending to the auditee, or use an override.',
      };
    }
  }

  const now = new Date().toISOString();
  const nextRevision = wp.revisionCount + 1;

  // Build the atomic write: status + attribution, the revision row, the audit row.
  const sets = ['status = ?', 'revision_count = revision_count + 1', 'updated_at = ?'];
  const updateArgs: (string | number | null)[] = [toStatus, now];
  if (meta.attribution) {
    const a = meta.attribution;
    sets.push(`${a.date} = ?`);
    updateArgs.push(now);
    if (a.byId) {
      sets.push(`${a.byId} = ?`);
      updateArgs.push(actor.userId);
    }
    if (a.byName) {
      sets.push(`${a.byName} = ?`);
      updateArgs.push(actor.userName);
    }
    if (a.comments && comment) {
      sets.push(`${a.comments} = ?`);
      updateArgs.push(comment);
    }
  }
  updateArgs.push(workPaperId, organizationId);

  const statements: InStatement[] = [
    {
      sql: `UPDATE work_papers SET ${sets.join(', ')} WHERE work_paper_id = ? AND organization_id = ?`,
      args: updateArgs,
    },
    insertRevisionStatement({
      workPaperId,
      revisionNumber: nextRevision,
      action: toStatus,
      fromStatus,
      toStatus,
      comments: comment,
      changesSummary: null,
      userId: actor.userId,
      userName: actor.userName,
    }),
    buildAuditStatement({
      organizationId,
      userId: actor.userId,
      action: 'WORK_PAPER.transition',
      entityType: 'work_paper',
      entityId: workPaperId,
      details: `${fromStatus} -> ${toStatus}`,
    }),
  ];
  await db.batch(statements, 'write');

  // Notify on the right events (submit, send, response). Best-effort, so a
  // missing template never fails a transition.
  if (meta.notifyTemplate) {
    await enqueueNotification(db, {
      organizationId,
      templateCode: meta.notifyTemplate,
      entityType: 'work_paper',
      entityId: workPaperId,
      actorUserId: actor.userId,
    });
  }

  // A status move changes every dashboard count for the organisation, so the
  // aggregations are cleared before the caller redirects into them.
  await invalidateDashboard(db, organizationId);
  return { ok: true, fromStatus, toStatus };
}

/**
 * The workflow actions offered to the actor from the current status: the engine's
 * allowed next statuses filtered to those whose WORK_PAPERS.* permission the actor
 * holds, each with its button label. Drives the "only valid actions" on the detail.
 */
export interface OfferedAction {
  toStatus: string;
  label: string;
  requiresComment: boolean;
}

/**
 * A move the workflow defines from here that this actor may not make, and the
 * reason (Build Prompt 53).
 *
 * A filtered-out action used to vanish without trace, so "why can I not submit
 * my own draft?" had no answer on the screen and no answer in the logs either:
 * the two possible causes, a `status_transitions` row that names a different
 * role and a permission the actor's matrix does not grant, look identical from
 * the outside. Naming them is the difference between a support ticket and a
 * setting somebody can go and change.
 */
export interface WithheldAction {
  toStatus: string;
  label: string;
  reason: string;
}

export interface AvailableActions {
  offered: OfferedAction[];
  withheld: WithheldAction[];
}

/**
 * The actions offered to this actor from the current status, and the ones the
 * workflow defines but withholds from them. The detail screen shows the first
 * as buttons and the second as an explanation.
 */
/** The finding an action is being offered on: its state and whose work it is. */
export interface ActionSubject {
  status: string;
  /** The auditor the finding is assigned to, when it has one. */
  assignedAuditorId?: string | null;
}

/**
 * Whether an authoring action belongs to this actor.
 *
 * Submitting a finding is the auditor's move, not the reviewer's: a head of
 * audit opening someone's draft should be waiting for it to arrive, not being
 * invited to release it on their behalf (Build Prompt 55). So an authoring
 * action is offered to the finding's own auditor, and to anyone who may edit it
 * while it has no auditor yet, which is the state a finding sits in between
 * being created and being assigned.
 *
 * This governs what is offered, not what is permitted: the batch release on the
 * work papers list deliberately lets a reviewer send several findings on an
 * auditor's behalf, and the executor's own gate is the matrix grant.
 */
function ownsAuthoring(subject: ActionSubject, actor: TransitionActor): boolean {
  const assigned = (subject.assignedAuditorId ?? '').trim();
  return assigned === '' || assigned === actor.userId;
}

export async function availableActions(
  db: Client,
  subject: ActionSubject,
  actor: TransitionActor,
): Promise<AvailableActions> {
  const [transitions, terminals] = await Promise.all([
    loadTransitions(db, WORK_PAPER_ENUM_TYPE),
    loadTerminalStates(db, WORK_PAPER_ENUM_TYPE),
  ]);
  // Every status comparison here is whitespace and case tolerant. These rows are
  // operator-managed, and a trailing space in `from_status` is invisible on the
  // screens that show it while matching nothing at all (Build Prompt 55).
  if (terminals.some((terminal) => sameStatus(terminal, subject.status))) {
    return { offered: [], withheld: [] };
  }
  const offered: OfferedAction[] = [];
  const withheld: WithheldAction[] = [];
  for (const t of transitions) {
    if (!sameStatus(t.fromStatus, subject.status)) continue;
    const meta = actionForTarget(t.toStatus);
    // A target this application has no catalogue entry for is a workflow row
    // the code cannot act on at all; it is not withheld from this person.
    if (!meta) continue;
    if (t.requiredRole && !actor.isPlatformOwner && t.requiredRole !== actor.roleCode) {
      withheld.push({
        toStatus: t.toStatus,
        label: meta.label,
        reason: `the workflow reserves it for the ${t.requiredRole} role`,
      });
      continue;
    }
    if (!holdsGrant(actor, meta)) {
      withheld.push({
        toStatus: t.toStatus,
        label: meta.label,
        reason: `your role does not hold ${meta.grant.module}.${meta.grant.action}`,
      });
      continue;
    }
    // An authoring action on somebody else's finding is simply not this
    // person's move, so it is not listed as withheld either: there is nothing
    // for a reviewer to fix, and telling them they lack a permission they do
    // hold would be a lie.
    if (meta.authoring && !ownsAuthoring(subject, actor)) continue;
    offered.push({ toStatus: t.toStatus, label: meta.label, requiresComment: t.requiresComment });
  }
  return { offered, withheld };
}

export async function offeredActions(
  db: Client,
  subject: ActionSubject,
  actor: TransitionActor,
): Promise<OfferedAction[]> {
  return (await availableActions(db, subject, actor)).offered;
}
