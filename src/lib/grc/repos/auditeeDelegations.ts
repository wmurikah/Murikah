/**
 * Delegations on the auditee side: a unit manager handing the drafting of a
 * response to their staff, and the return (Build Prompt 68).
 *
 * The row is the delegate's entire standing in the product. Staff hold no audit
 * permission and are not meant to: they act because a manager named them on a
 * live delegation, in exactly the way a responsible acts because they are named
 * on the finding. So `holdsLiveDelegation` is a real access check and not a
 * convenience, and it is what the evidence boundary asks as well.
 *
 * Every read and write is scoped by the acting organization_id, and column names
 * come from the typed schema layer. This module stores and reads: whether the
 * finding may move is decided by the stage machine (workflow/auditeeLoop.ts) and
 * by `status_transitions`, never here.
 */
import type { Client, InStatement } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { DELEGATION_STATUS } from '@grc/workflow/auditeeLoop';

const D = cols(C.auditee_delegations);
const WP = cols(C.work_papers);

const s = (v: unknown): string | null => (v == null ? null : String(v));

export interface Delegation {
  delegationId: string;
  workPaperId: string;
  round: number;
  delegatedBy: string;
  delegatedByName: string | null;
  delegatedTo: string;
  delegatedToName: string | null;
  instructions: string | null;
  status: string;
  delegatedAt: string | null;
  returnedAt: string | null;
  returnNote: string | null;
}

function toDelegation(r: Record<string, unknown>): Delegation {
  return {
    delegationId: String(r.delegation_id),
    workPaperId: String(r.work_paper_id),
    round: Number(r.round_number ?? 1) || 1,
    delegatedBy: String(r.delegated_by ?? ''),
    delegatedByName: s(r.delegated_by_name),
    delegatedTo: String(r.delegated_to ?? ''),
    delegatedToName: s(r.delegated_to_name),
    instructions: s(r.instructions),
    status: String(r.status ?? DELEGATION_STATUS.ISSUED),
    delegatedAt: s(r.delegated_at),
    returnedAt: s(r.returned_at),
    returnNote: s(r.return_note),
  };
}

const SELECT = `SELECT ${D.delegation_id} AS delegation_id, ${D.work_paper_id} AS work_paper_id,
                 ${D.round_number} AS round_number, ${D.delegated_by} AS delegated_by,
                 ${D.delegated_by_name} AS delegated_by_name, ${D.delegated_to} AS delegated_to,
                 ${D.delegated_to_name} AS delegated_to_name, ${D.instructions} AS instructions,
                 ${D.status} AS status, ${D.delegated_at} AS delegated_at,
                 ${D.returned_at} AS returned_at, ${D.return_note} AS return_note
            FROM auditee_delegations`;

/** Every delegation on a finding, oldest first, for the trail. */
export async function listDelegations(
  db: Client,
  organizationId: string,
  workPaperId: string,
): Promise<Delegation[]> {
  const res = await db.execute({
    sql: `${SELECT}
           WHERE ${D.organization_id} = ? AND ${D.work_paper_id} = ?
        ORDER BY ${D.delegated_at} ASC`,
    args: [organizationId, workPaperId],
  });
  return res.rows.map((r) => toDelegation(r as Record<string, unknown>));
}

/**
 * The delegation currently in force on a finding, if any: the one a delegate is
 * still holding. A returned or closed delegation is history, and history does
 * not confer access.
 */
export async function liveDelegation(
  db: Client,
  organizationId: string,
  workPaperId: string,
): Promise<Delegation | null> {
  const res = await db.execute({
    sql: `${SELECT}
           WHERE ${D.organization_id} = ? AND ${D.work_paper_id} = ? AND ${D.status} = ?
        ORDER BY ${D.delegated_at} DESC LIMIT 1`,
    args: [organizationId, workPaperId, DELEGATION_STATUS.ISSUED],
  });
  const row = res.rows[0];
  return row ? toDelegation(row as Record<string, unknown>) : null;
}

/**
 * Whether this person is holding a live delegation on this finding: the whole
 * of a staff member's authority to draft, attach and return.
 *
 * A returned delegation deliberately does not count. A supervisor who handed
 * the draft back should not still be able to change it while their manager is
 * reading it; if the manager wants more, they delegate again, and the trail
 * shows both handovers.
 */
export async function holdsLiveDelegation(
  db: Client,
  organizationId: string,
  workPaperId: string,
  userId: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: `SELECT 1 FROM auditee_delegations
           WHERE ${D.organization_id} = ? AND ${D.work_paper_id} = ?
             AND ${D.delegated_to} = ? AND ${D.status} = ? LIMIT 1`,
    args: [organizationId, workPaperId, userId, DELEGATION_STATUS.ISSUED],
  });
  return res.rows.length > 0;
}

/** The user ids of everyone ever delegated to on a finding, for the copy list. */
export async function delegateIds(
  db: Client,
  organizationId: string,
  workPaperId: string,
): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT DISTINCT ${D.delegated_to} AS user_id FROM auditee_delegations
           WHERE ${D.organization_id} = ? AND ${D.work_paper_id} = ?`,
    args: [organizationId, workPaperId],
  });
  return res.rows.map((r) => String(r.user_id)).filter(Boolean);
}

export interface DelegateInput {
  workPaperId: string;
  round: number;
  delegatedBy: string;
  delegatedByName: string;
  delegatedTo: string;
  delegatedToName: string;
  instructions: string | null;
}

/** The insert for one delegation, batchable with the finding's stage change. */
export function insertDelegationStatement(
  organizationId: string,
  delegationId: string,
  input: DelegateInput,
  now: string,
): InStatement {
  return {
    sql: `INSERT INTO auditee_delegations
            (${D.delegation_id}, ${D.organization_id}, ${D.work_paper_id}, ${D.round_number},
             ${D.delegated_by}, ${D.delegated_by_name}, ${D.delegated_to}, ${D.delegated_to_name},
             ${D.instructions}, ${D.status}, ${D.delegated_at})
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      delegationId,
      organizationId,
      input.workPaperId,
      input.round,
      input.delegatedBy,
      input.delegatedByName,
      input.delegatedTo,
      input.delegatedToName,
      input.instructions,
      DELEGATION_STATUS.ISSUED,
      now,
    ],
  };
}

/** Record the delegate handing the draft back, with whatever they said about it. */
export function returnDelegationStatement(
  organizationId: string,
  delegationId: string,
  note: string | null,
  now: string,
): InStatement {
  return {
    sql: `UPDATE auditee_delegations
             SET ${D.status} = ?, ${D.returned_at} = ?, ${D.return_note} = ?
           WHERE ${D.delegation_id} = ? AND ${D.organization_id} = ? AND ${D.status} = ?`,
    args: [
      DELEGATION_STATUS.RETURNED,
      now,
      note,
      delegationId,
      organizationId,
      DELEGATION_STATUS.ISSUED,
    ],
  };
}

/**
 * Close every delegation still open on a finding, which is what releasing to
 * audit does: the work has left the auditee side, so nobody on it is still
 * holding a brief. Without this a delegate would keep write access to a
 * response that is already with the reviewer.
 */
export function closeDelegationsStatement(
  organizationId: string,
  workPaperId: string,
  now: string,
): InStatement {
  return {
    sql: `UPDATE auditee_delegations
             SET ${D.status} = ?, ${D.closed_at} = ?
           WHERE ${D.organization_id} = ? AND ${D.work_paper_id} = ? AND ${D.status} IN (?, ?)`,
    args: [
      DELEGATION_STATUS.CLOSED,
      now,
      organizationId,
      workPaperId,
      DELEGATION_STATUS.ISSUED,
      DELEGATION_STATUS.RETURNED,
    ],
  };
}

/** Move the finding's auditee stage, batchable with whatever caused the move. */
export function setStageStatement(
  organizationId: string,
  workPaperId: string,
  stage: string,
  now: string,
): InStatement {
  return {
    sql: `UPDATE work_papers SET ${WP.auditee_stage} = ?, ${WP.updated_at} = ?
           WHERE ${WP.work_paper_id} = ? AND ${WP.organization_id} = ?`,
    args: [stage, now, workPaperId, organizationId],
  };
}

/**
 * The staff a unit manager may delegate to: active users in the same
 * organisation and the same affiliate, minus the manager themselves.
 *
 * Scoped by affiliate on purpose. A depot manager in Mombasa delegating to
 * somebody in Kisumu is not a handover, it is a mistake, and a picker that
 * offers the whole company invites it.
 */
export interface DelegateCandidate {
  userId: string;
  name: string;
  email: string;
}

export async function listDelegateCandidates(
  db: Client,
  organizationId: string,
  affiliateCode: string | null,
  exceptUserId: string,
): Promise<DelegateCandidate[]> {
  const U = cols(C.users);
  const sameAffiliate = affiliateCode ? ` AND ${U.affiliate_code} = ?` : '';
  const res = await db.execute({
    sql: `SELECT ${U.user_id} AS user_id, ${U.full_name} AS full_name, ${U.email} AS email
            FROM users
           WHERE ${U.organization_id} = ? AND ${U.deleted_at} IS NULL
             AND ${U.email} IS NOT NULL
             AND COALESCE(${U.is_platform_owner}, 0) = 0
             AND UPPER(COALESCE(${U.status}, '')) NOT IN
                 ('INACTIVE', 'DISABLED', 'SUSPENDED', 'ARCHIVED', 'DELETED')
             AND ${U.user_id} <> ?${sameAffiliate}
        ORDER BY ${U.full_name} ASC
           LIMIT 200`,
    args: affiliateCode
      ? [organizationId, exceptUserId, affiliateCode]
      : [organizationId, exceptUserId],
  });
  return res.rows.map((r) => ({
    userId: String(r.user_id),
    name: String(r.full_name ?? r.email),
    email: String(r.email ?? ''),
  }));
}
