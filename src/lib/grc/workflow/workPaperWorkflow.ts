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
import { WORK_PAPER_ENUM_TYPE, WP_STATUS, actionForTarget } from './workPaperActions';
import { getWorkPaper } from '@grc/repos/workPapers';
import { insertRevisionStatement } from '@grc/repos/revisions';
import { enqueueNotification } from '@grc/repos/notify';
import { buildAuditStatement } from '@grc/repos/audit';

export interface TransitionActor {
  userId: string;
  userName: string;
  roleCode: string;
  isPlatformOwner: boolean;
  perms: string[];
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

  // The WORK_PAPERS.* permission for this action (a platform owner is not exempt
  // from it; their permission set carries what they may do).
  if (!actor.perms.includes(meta.permission)) {
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

export async function offeredActions(
  db: Client,
  fromStatus: string,
  actor: TransitionActor,
): Promise<OfferedAction[]> {
  const [transitions, terminals] = await Promise.all([
    loadTransitions(db, WORK_PAPER_ENUM_TYPE),
    loadTerminalStates(db, WORK_PAPER_ENUM_TYPE),
  ]);
  if (terminals.includes(fromStatus)) return [];
  const out: OfferedAction[] = [];
  for (const t of transitions) {
    if (t.fromStatus !== fromStatus) continue;
    if (t.requiredRole && !actor.isPlatformOwner && t.requiredRole !== actor.roleCode) continue;
    const meta = actionForTarget(t.toStatus);
    if (!meta || !actor.perms.includes(meta.permission)) continue;
    out.push({ toStatus: t.toStatus, label: meta.label, requiresComment: t.requiresComment });
  }
  return out;
}
