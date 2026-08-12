/**
 * The work-paper transition executor. Every status change runs through here, so
 * the ported lifecycle is enforced in one place, never hard-coded:
 *
 *  1. the move's matrix grant is required (from the action catalogue, per
 *     `from -> to` pair rather than per target status), resolved through the
 *     shared accessor so an organisation that inherits the platform defaults is
 *     answered from those, on top of
 *  2. the foundation engine's validation of the transition against
 *     status_transitions (from -> to allowed, required_role held, requires_comment
 *     satisfied, not a terminal state);
 *  3. the SUPER_ADMIN evidence_override from the source: sending a finding to the
 *     auditee needs at least one piece of evidence, unless the actor may override;
 *  4. then, atomically, the status is set, revision_count incremented, the dated
 *     attribution stamped, an append-only work_paper_revisions row written, and an
 *     audit_log row recorded;
 *  5. and a notification is enqueued for every round of the review loop: the
 *     submission, the return for revision (with the reviewer's comment), the
 *     approval and the share with the auditee, each addressed to the party who
 *     must act next (Build Prompt 62).
 *
 * A platform owner is exempt from the required_role (as in the engine) but the
 * grant still applies through their matrix, which carries everything.
 *
 * Every refusal, at any of those steps, logs one `[grc.workpaper.submit]` line
 * naming the move, the permission it needed, the organisation and role it was
 * asked of, and which rows answered (Build Prompt 57). A refusal that leaves
 * nothing behind is a support ticket; one that names its inputs is a setting
 * somebody can go and change.
 */
import type { Client, InStatement } from '@libsql/client/web';
import {
  checkTransition,
  enumTypesWithTransition,
  loadTransitions,
  loadTerminalStates,
} from './transitions';
import {
  WORK_PAPER_ENUM_TYPE,
  WP_STATUS,
  actionForTarget,
  canonicalTarget,
  grantForTransition,
  sameStatus,
  type Grant,
} from './workPaperActions';
import { canMatrix, type PermissionMatrix } from '@grc/auth/matrix';
import { resolveRoleAccess } from '@grc/auth/rbac';
import { completenessOf, getWorkPaper } from '@grc/repos/workPapers';
import { countAttachments } from '@grc/repos/evidence';
import { incompleteMessage, missingForSubmission } from './workPaperCompleteness';
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
   *
   * It is what the offer is rendered from. A write resolves its own through
   * `resolveTransitionAccess` (Build Prompt 57), so what a caller carries can
   * neither widen nor narrow what is actually permitted.
   */
  matrix: PermissionMatrix;
  perms: string[];
}

/**
 * Whether this matrix holds the grant a `from -> to` move requires
 * (Build Prompt 56).
 *
 * The one guard both paths use. `grantForTransition` decides which grant that
 * is, per move rather than per target status, so the auditor's submit asks for
 * `update` and the reviewer's verdict asks for `approve`; nothing here, on the
 * detail, or on the list restates the mapping. Exported because the work papers
 * list has to know, before it draws a tick box, whether the batch release it
 * offers would be allowed.
 */
export function holdsTransitionGrant(
  matrix: PermissionMatrix,
  fromStatus: string,
  toStatus: string,
): boolean {
  const grant = grantForTransition(fromStatus, toStatus);
  return grant != null && canMatrix(matrix, grant.action, grant.module);
}

/** The access a transition is decided against, resolved for one request. */
export interface TransitionAccess {
  matrix: PermissionMatrix;
  /**
   * True when the organisation holds no `role_permissions` rows of its own and
   * the grants come from the GLOBAL platform default. Logged on a refusal,
   * because "which rows answered this" is the first question a refusal that
   * looks wrong raises, and nothing on the screens can answer it.
   */
  inherited: boolean;
}

/**
 * The access a work-paper transition is decided against, from the one accessor
 * the whole product resolves permissions through (Build Prompt 57).
 *
 * The executor asks this itself rather than trusting the matrix on the actor:
 * the session's matrix is resolved the same way by the middleware, but a write
 * that re-resolves cannot be widened or narrowed by a caller that assembled one
 * differently, and the resolution reports whether the organisation's own rows or
 * the platform defaults answered.
 */
export async function resolveTransitionAccess(
  db: Client,
  organizationId: string,
  actor: TransitionActor,
): Promise<TransitionAccess> {
  const access = await resolveRoleAccess(db, actor.roleCode, organizationId, actor.isPlatformOwner);
  return { matrix: access.matrix, inherited: access.inherited };
}

/** The tag every refused work-paper transition is logged under. */
const SUBMIT_TAG = '[grc.workpaper.submit]';

/**
 * One line naming why a transition was refused (Build Prompt 57).
 *
 * A refusal used to leave nothing behind, so diagnosing one meant guessing
 * between a missing grant, a workflow row that does not match, and an
 * organisation resolving the wrong set of grants. The line names all three
 * inputs: the move, the permission it required, the organisation and role it was
 * asked of, and whether the grants came from the organisation's own rows or the
 * GLOBAL default. Identifiers only, never a name, an address or a secret.
 */
function logRefusal(fields: {
  workPaperId: string;
  organizationId: string;
  roleCode: string;
  from: string | null;
  to: string;
  permission: Grant | null;
  inherited: boolean | null;
  code: string;
  message: string;
  /** The workflow the move was looked up under (Build Prompt 61). */
  enumType?: string;
  /**
   * The workflows that do define this from -> to. When it names one the search
   * did not, the refusal is an enum-scoping mismatch and says so itself: the row
   * an operator finds when they go looking is real, it simply belongs to another
   * workflow.
   */
  enumTypesWithMove?: string[];
}): void {
  console.error(
    `${SUBMIT_TAG} refused`,
    JSON.stringify({
      work_paper_id: fields.workPaperId,
      from_status: fields.from,
      to_status: fields.to,
      permission: fields.permission
        ? `${fields.permission.module}.${fields.permission.action}`
        : null,
      organization_id: fields.organizationId,
      role_code: fields.roleCode,
      grants_from: fields.inherited === null ? null : fields.inherited ? 'GLOBAL' : 'organization',
      enum_type: fields.enumType ?? null,
      enum_types_with_move: fields.enumTypesWithMove ?? null,
      code: fields.code,
      reason: fields.message,
    }),
  );
}

export type TransitionResult =
  | { ok: true; fromStatus: string; toStatus: string }
  | {
      ok: false;
      code: 'not_found' | 'unknown_action' | 'forbidden' | 'evidence_required' | string;
      message: string;
    };

/**
 * The grant that lets a reviewer send a finding with no evidence on it.
 *
 * It reads from the derived list, and until now the list mapped it to nothing at
 * all, so the override the refusal message offers existed in the message and
 * nowhere else (Build Prompt 62). It now follows `WORK_PAPER.approve`: sending
 * to the auditee is the head of audit's act, and deciding that this particular
 * finding does not need an attachment is the same person's judgement. An auditor
 * still cannot make it.
 *
 * HOLDING IT IS NOT USING IT. Sending is already gated on `approve`, so a grant
 * alone would mean everyone who can send can also skip the evidence, and a gate
 * nobody can fail is not a gate. The override is therefore an act: the sender
 * ticks it on the send, this honours it only from somebody who holds the grant,
 * and the audit log records that a finding went out without evidence and who
 * decided that. The default stays the refusal.
 */
const EVIDENCE_OVERRIDE = 'WORK_PAPERS.evidence_override';

/** The tag a refused send-to-auditee is logged under. */
const AUDITEE_TAG = '[grc.workpaper.auditee]';

export async function executeTransition(
  db: Client,
  organizationId: string,
  workPaperId: string,
  toStatus: string,
  actor: TransitionActor,
  comment: string | null,
  access?: TransitionAccess,
  /**
   * The sender's deliberate "send this without evidence" (Build Prompt 62).
   * Honoured only from an actor who holds the override grant, and recorded in
   * the audit trail when it is used.
   */
  overrideEvidence = false,
): Promise<TransitionResult> {
  const refuse = (
    result: { ok: false; code: string; message: string },
    context: {
      from: string | null;
      to: string;
      inherited: boolean | null;
      /** The workflows that do define this move, when the engine refused it. */
      enumTypesWithMove?: string[];
    },
  ): TransitionResult => {
    logRefusal({
      workPaperId,
      organizationId,
      roleCode: actor.roleCode,
      from: context.from,
      to: context.to,
      permission: context.from === null ? null : grantForTransition(context.from, context.to),
      inherited: context.inherited,
      enumType: WORK_PAPER_ENUM_TYPE,
      enumTypesWithMove: context.enumTypesWithMove,
      code: result.code,
      message: result.message,
    });
    return result;
  };

  const wp = await getWorkPaper(db, organizationId, workPaperId);
  if (!wp) {
    return refuse(
      { ok: false, code: 'not_found', message: 'That work paper was not found.' },
      { from: null, to: toStatus, inherited: null },
    );
  }
  const fromStatus = wp.status;

  // The catalogue's own spelling of the target, so a move offered from a
  // hand-edited transition row is still stored as the status every other query
  // matches on (Build Prompt 57).
  const target = canonicalTarget(toStatus);
  const meta = target === null ? null : actionForTarget(target);
  if (target === null || !meta) {
    return refuse(
      { ok: false, code: 'unknown_action', message: 'Unknown workflow action.' },
      { from: fromStatus, to: toStatus, inherited: null },
    );
  }

  // The grant is resolved through the shared accessor, never from the matrix the
  // caller happens to be carrying: the write decides for itself, from the
  // organisation's own rows or the GLOBAL defaults it inherits (Build Prompt 57).
  const resolved = access ?? (await resolveTransitionAccess(db, organizationId, actor));
  if (!holdsTransitionGrant(resolved.matrix, fromStatus, target)) {
    return refuse(
      { ok: false, code: 'forbidden', message: 'You do not have permission for that action.' },
      { from: fromStatus, to: target, inherited: resolved.inherited },
    );
  }

  // The engine validates the transition itself: allowed, required_role, comment.
  const outcome = await checkTransition(db, WORK_PAPER_ENUM_TYPE, {
    from: fromStatus,
    to: target,
    roleCode: actor.roleCode,
    isPlatformOwner: actor.isPlatformOwner,
    comment,
  });
  if (!outcome.ok) {
    // When the workflow says the move does not exist, say which workflows it
    // does exist in. A `Draft -> Submitted` under `response_status` is a real
    // row that answers nothing here, and that is the one refusal a person
    // cannot diagnose by looking at the table (Build Prompt 61).
    const enumTypesWithMove =
      outcome.code === 'not_allowed'
        ? await enumTypesWithTransition(db, fromStatus, target)
        : undefined;
    return refuse(
      { ok: false, code: outcome.code, message: outcome.message },
      { from: fromStatus, to: target, inherited: resolved.inherited, enumTypesWithMove },
    );
  }

  // Evidence gate on sending to the auditee, with the SUPER_ADMIN override. It
  // guards the first share only: reopening a finding for another response round
  // is not a fresh disclosure, and the evidence it demanded was already attached
  // when the finding first went out.
  let evidenceOverridden = false;
  const alreadySent = wp.sent_to_auditee_date != null;
  if (target === WP_STATUS.SENT_TO_AUDITEE && !alreadySent) {
    // Counted through the repository the Evidence panel reads, so the gate sees
    // exactly what the auditor sees (Build Prompt 62).
    const attached = await countAttachments(db, organizationId, 'work_paper', workPaperId);
    const mayOverride = actor.perms.includes(EVIDENCE_OVERRIDE);
    const overriding = mayOverride && overrideEvidence;
    if (!overriding && attached === 0) {
      // A refusal an auditor can contradict by pointing at their screen has to
      // say what it counted and where it looked.
      console.error(
        `${AUDITEE_TAG} refused`,
        JSON.stringify({
          work_paper_id: workPaperId,
          organization_id: organizationId,
          entity_type: 'work_paper',
          evidence_count: attached,
          role_code: actor.roleCode,
          may_override: mayOverride,
          override_requested: overrideEvidence,
          reason: 'no evidence is attached to this work paper',
        }),
      );
      return refuse(
        {
          ok: false,
          code: 'evidence_required',
          message: mayOverride
            ? 'Attach evidence before sending to the auditee, or tick the override to send without it.'
            : 'Attach evidence before sending to the auditee.',
        },
        { from: fromStatus, to: target, inherited: resolved.inherited },
      );
    }
    evidenceOverridden = overriding && attached === 0;
  }

  const now = new Date().toISOString();
  const nextRevision = wp.revisionCount + 1;

  // Build the atomic write: status + attribution, the revision row, the audit row.
  const sets = ['status = ?', 'revision_count = revision_count + 1', 'updated_at = ?'];
  const updateArgs: (string | number | null)[] = [target, now];
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
      action: target,
      fromStatus,
      toStatus: target,
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
      details: `${fromStatus} -> ${target}`,
    }),
  ];
  // Sending with nothing attached is a decision somebody made, so the trail says
  // who made it rather than leaving a finding that went out bare unexplained.
  if (evidenceOverridden) {
    statements.push(
      buildAuditStatement({
        organizationId,
        userId: actor.userId,
        action: 'WORK_PAPER.evidence_override',
        entityType: 'work_paper',
        entityId: workPaperId,
        details: `${target} with no evidence attached`,
      }),
    );
  }
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
      // The reviewer's reason travels with the decision (Build Prompt 62).
      comment,
    });
  }

  // A status move changes every dashboard count for the organisation, so the
  // aggregations are cleared before the caller redirects into them.
  await invalidateDashboard(db, organizationId);
  return { ok: true, fromStatus, toStatus: target };
}

/**
 * Submit a finding for review, the one path every Submit runs through (Build
 * Prompt 59).
 *
 * The completeness gate lives here rather than in `executeTransition`, and that
 * is the point of it being one function: the transition engine is unchanged, and
 * the same precondition applies whichever button was pressed. Submitting is
 * offered from three places (the create and edit forms, the detail's own Submit,
 * and the batch release on the list), and a rule enforced in two of the three is
 * not a rule, it is a detour.
 *
 * It is checked against the stored row rather than against a posted form, so the
 * answer is the same for a finding saved a minute ago and one saved last week.
 *
 * The refusal names every missing field, not the first: an auditor should learn
 * the whole of what is left in one attempt.
 */
export type SubmitResult =
  | TransitionResult
  | { ok: false; code: 'incomplete'; message: string; missing: string[] };

export async function submitForReview(
  db: Client,
  organizationId: string,
  workPaperId: string,
  actor: TransitionActor,
  /** The note the auditor sent it with, kept on the revision row as any move's is. */
  comment: string | null = null,
  access?: TransitionAccess,
): Promise<SubmitResult> {
  const wp = await getWorkPaper(db, organizationId, workPaperId);
  if (!wp) return { ok: false, code: 'not_found', message: 'That work paper was not found.' };

  const missing = missingForSubmission(completenessOf(wp));
  if (missing.length > 0) {
    return { ok: false, code: 'incomplete', message: incompleteMessage(missing), missing };
  }
  return executeTransition(
    db,
    organizationId,
    workPaperId,
    WP_STATUS.SUBMITTED,
    actor,
    comment,
    access,
  );
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
    // A target this application has no catalogue entry for is a workflow row
    // the code cannot act on at all; it is not withheld from this person.
    // What is offered is the catalogue's spelling of the target, never the row's:
    // the button carries the status the save will store (Build Prompt 57).
    const target = canonicalTarget(t.toStatus);
    const meta = target === null ? null : actionForTarget(target);
    if (target === null || !meta) continue;
    if (t.requiredRole && !actor.isPlatformOwner && t.requiredRole !== actor.roleCode) {
      withheld.push({
        toStatus: target,
        label: meta.label,
        reason: `the workflow reserves it for the ${t.requiredRole} role`,
      });
      continue;
    }
    // The grant this move needs, not the one its target usually needs: the same
    // status is reached by the auditor's work and by the reviewer's.
    const grant = grantForTransition(t.fromStatus, target) ?? meta.grant;
    if (!canMatrix(actor.matrix, grant.action, grant.module)) {
      withheld.push({
        toStatus: target,
        label: meta.label,
        reason: `your role does not hold ${grant.module}.${grant.action}`,
      });
      continue;
    }
    // An authoring action on somebody else's finding is simply not this
    // person's move, so it is not listed as withheld either: there is nothing
    // for a reviewer to fix, and telling them they lack a permission they do
    // hold would be a lie.
    if (meta.authoring && !ownsAuthoring(subject, actor)) continue;
    offered.push({ toStatus: target, label: meta.label, requiresComment: t.requiresComment });
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
