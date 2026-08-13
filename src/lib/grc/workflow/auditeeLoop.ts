/**
 * The auditee side of a finding: who is holding it, and what they may do next
 * (Build Prompt 68). Pure and import-free, so node strips types and unit-tests
 * this directly, the same convention as the other workflow catalogues.
 *
 * WHAT THIS IS NOT. It is not a second status machine. The finding's own status
 * still moves through `status_transitions` (Sent to Auditee, Response Received,
 * Response Reviewed) and that table stays the authority, exactly as it does
 * everywhere else. What it could never say is which of several people on the
 * auditee side is holding the finding right now, and that is the whole of what
 * this adds: a unit manager who has passed the drafting to a depot supervisor
 * and a unit manager who has not touched it are both "sent to auditee, nothing
 * back yet", so the delay looked the same whoever it belonged to.
 *
 * WHO ACTS BY WHAT. The auditee side acts by being NAMED, never by holding an
 * audit permission. A responsible or a CC recipient is named on the finding. A
 * delegate is named on a live delegation, which is their entire standing in the
 * product: staff have no audit permissions at all, and are not meant to.
 *
 * THE LOOP. Audit sends the finding; the responsibles hold it. The unit manager
 * may delegate the drafting to their staff and take it back when the delegate
 * returns it, as many times as the work needs. When the manager is satisfied
 * they release it to audit, who accept it, modify it, or send it back for
 * another round.
 */

/** Which side of the auditee handover a finding is on. */
export const AUDITEE_STAGE = {
  /** With the responsibles: sent, or returned by audit for another round. */
  WITH_AUDITEE: 'WITH_AUDITEE',
  /** A delegate is drafting the response. */
  DELEGATED: 'DELEGATED',
  /** The delegate has handed it back and the unit manager is reviewing it. */
  WITH_UNIT_MANAGER: 'WITH_UNIT_MANAGER',
  /** Released: audit is reviewing the response. */
  WITH_AUDIT: 'WITH_AUDIT',
  /** Audit accepted it, so the loop is finished for this finding. */
  CLOSED: 'CLOSED',
} as const;

export type AuditeeStage = (typeof AUDITEE_STAGE)[keyof typeof AUDITEE_STAGE];

/** The state of one handover from a unit manager to their staff. */
export const DELEGATION_STATUS = {
  /** The delegate holds it. */
  ISSUED: 'ISSUED',
  /** The delegate has handed it back to the manager. */
  RETURNED: 'RETURNED',
  /** The finding moved on, so the delegation is no longer live. */
  CLOSED: 'CLOSED',
} as const;

export type DelegationStatus = (typeof DELEGATION_STATUS)[keyof typeof DELEGATION_STATUS];

/** Everything that can happen in the loop, each one an event somebody is told about. */
export type AuditeeMove =
  | 'send'
  | 'delegate'
  | 'return_to_manager'
  | 'release_to_audit'
  | 'accept'
  | 'modify'
  | 'request_change';

/** Who is entitled to make a move, in the terms the auditee side is named in. */
export type MoveActor = 'audit' | 'unit_manager' | 'delegate';

interface MoveRule {
  /** The stages the move is legal from. An empty list means "from anywhere". */
  from: readonly AuditeeStage[];
  to: AuditeeStage;
  actor: MoveActor;
  /** What the trail and the email call it. */
  label: string;
}

/**
 * The loop, written once.
 *
 * A return from audit goes to WITH_AUDITEE and not to some third "returned"
 * state, because that is precisely what it is: the finding is back with the
 * responsibles and they must answer it, which is the same position a fresh send
 * leaves them in. Inventing a state that behaves identically to another one is
 * how a state machine acquires branches nobody can tell apart.
 */
const MOVES: Record<AuditeeMove, MoveRule> = {
  send: {
    from: [],
    to: AUDITEE_STAGE.WITH_AUDITEE,
    actor: 'audit',
    label: 'Sent to the auditee',
  },
  delegate: {
    from: [AUDITEE_STAGE.WITH_AUDITEE, AUDITEE_STAGE.WITH_UNIT_MANAGER],
    to: AUDITEE_STAGE.DELEGATED,
    actor: 'unit_manager',
    label: 'Delegated to staff',
  },
  return_to_manager: {
    from: [AUDITEE_STAGE.DELEGATED],
    to: AUDITEE_STAGE.WITH_UNIT_MANAGER,
    actor: 'delegate',
    label: 'Returned to the unit manager',
  },
  release_to_audit: {
    from: [AUDITEE_STAGE.WITH_AUDITEE, AUDITEE_STAGE.WITH_UNIT_MANAGER],
    to: AUDITEE_STAGE.WITH_AUDIT,
    actor: 'unit_manager',
    label: 'Released to audit',
  },
  accept: {
    from: [AUDITEE_STAGE.WITH_AUDIT],
    to: AUDITEE_STAGE.CLOSED,
    actor: 'audit',
    label: 'Accepted by audit',
  },
  modify: {
    from: [AUDITEE_STAGE.WITH_AUDIT],
    to: AUDITEE_STAGE.CLOSED,
    actor: 'audit',
    label: 'Modified and accepted by audit',
  },
  request_change: {
    from: [AUDITEE_STAGE.WITH_AUDIT],
    to: AUDITEE_STAGE.WITH_AUDITEE,
    actor: 'audit',
    label: 'Returned by audit for change',
  },
};

/** The moves, for a catalogue-driven test and for the trail's labels. */
export const AUDITEE_MOVES = Object.keys(MOVES) as AuditeeMove[];

export function isAuditeeMove(value: string): value is AuditeeMove {
  return Object.prototype.hasOwnProperty.call(MOVES, value);
}

/**
 * The stage a finding is in, read tolerantly.
 *
 * A finding sent before the stage existed carries none, and a finding whose
 * stage was hand-set carries whatever case it was typed in. Both are the same
 * position as a fresh send, so both read as WITH_AUDITEE rather than as an
 * error: the loop has to work on the findings that are already out there.
 */
export function stageOf(raw: string | null | undefined): AuditeeStage {
  const value = String(raw ?? '')
    .trim()
    .toUpperCase();
  return isStage(value) ? value : AUDITEE_STAGE.WITH_AUDITEE;
}

function isStage(value: string): value is AuditeeStage {
  return (Object.values(AUDITEE_STAGE) as string[]).includes(value);
}

/** Whether a move is legal from the stage the finding is in. */
export function canMove(stage: AuditeeStage, move: AuditeeMove): boolean {
  const rule = MOVES[move];
  return rule.from.length === 0 || rule.from.includes(stage);
}

/** The stage a move leaves the finding in, or null when the move is not legal. */
export function nextStage(stage: AuditeeStage, move: AuditeeMove): AuditeeStage | null {
  return canMove(stage, move) ? MOVES[move].to : null;
}

/** Who is entitled to make the move. */
export function actorFor(move: AuditeeMove): MoveActor {
  return MOVES[move].actor;
}

/** What the trail and the notification call the move. */
export function moveLabel(move: AuditeeMove): string {
  return MOVES[move].label;
}

/** What the screen calls a stage, in the auditee's own terms. */
export function stageLabel(stage: AuditeeStage): string {
  switch (stage) {
    case AUDITEE_STAGE.DELEGATED:
      return 'With the delegate';
    case AUDITEE_STAGE.WITH_UNIT_MANAGER:
      return 'With the unit manager';
    case AUDITEE_STAGE.WITH_AUDIT:
      return 'With internal audit';
    case AUDITEE_STAGE.CLOSED:
      return 'Closed by audit';
    default:
      return 'With the auditee';
  }
}

/**
 * The sentence under the stage badge, which says what has to happen next rather
 * than restating the state. "With the delegate" tells a unit manager where the
 * work is; it does not tell them that they are waiting rather than late.
 */
export function stageHint(stage: AuditeeStage): string {
  switch (stage) {
    case AUDITEE_STAGE.DELEGATED:
      return 'A member of staff is drafting the response and will return it to the unit manager.';
    case AUDITEE_STAGE.WITH_UNIT_MANAGER:
      return 'The draft is back with the unit manager to review and release to audit.';
    case AUDITEE_STAGE.WITH_AUDIT:
      return 'Internal audit is reviewing the released response.';
    case AUDITEE_STAGE.CLOSED:
      return 'Internal audit has accepted the response. Nothing further is needed.';
    default:
      return 'The unit manager may respond directly, or delegate the drafting to their staff.';
  }
}

/** How the acting person is standing on this finding, worked out once per request. */
export interface AuditeeStanding {
  /** Named as a responsible: the unit manager's authority to act. */
  isResponsible: boolean;
  /** Copied in: they see everything and act on nothing. */
  isCc: boolean;
  /** Holding a live delegation on this finding. */
  isDelegate: boolean;
  /** Holds the audit-side review permission. */
  isAudit: boolean;
}

/**
 * Whether this person may make this move, from this stage.
 *
 * Standing and stage are separate questions and both have to hold. A unit
 * manager may release, but not while a delegate is still drafting; a delegate
 * may return, but only what they were actually given. A CC recipient is
 * deliberately capable of nothing: being copied is not being asked.
 */
export function mayMove(
  standing: AuditeeStanding,
  stage: AuditeeStage,
  move: AuditeeMove,
): boolean {
  if (!canMove(stage, move)) return false;
  switch (actorFor(move)) {
    case 'audit':
      return standing.isAudit;
    case 'unit_manager':
      return standing.isResponsible;
    default:
      return standing.isDelegate;
  }
}

/** Every move this person may make right now, in catalogue order, for the screen. */
export function offeredMoves(standing: AuditeeStanding, stage: AuditeeStage): AuditeeMove[] {
  return AUDITEE_MOVES.filter((m) => mayMove(standing, stage, m) && m !== 'send');
}

/** An audit decision, parsed from the form. Null when it did not come from us. */
export type AuditDecision = 'accept' | 'modify' | 'request_change';

export function parseAuditDecision(raw: string | null): AuditDecision | null {
  if (raw === 'accept' || raw === 'modify' || raw === 'request_change') return raw;
  // The review form's original two decisions, kept working: an older page or a
  // bookmarked post must not start failing because a third was added.
  if (raw === 'request_changes') return 'request_change';
  return null;
}
