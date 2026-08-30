/**
 * How the acting person stands on one finding's auditee side (Build Prompt 68),
 * resolved in one query and in one place.
 *
 * Every endpoint in the loop and the thread screen itself ask the same question:
 * is this person a responsible, a copy recipient, a delegate holding a live
 * brief, or audit? A second spelling of that question is a second answer, and
 * the answer is an access decision, so there is exactly one.
 *
 * The auditee side has no audit permissions and is not meant to. Its authority
 * is being named: on the finding, or on a delegation. `isAudit` is the only part
 * that reads the permission matrix, and it is the audit side of the loop.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { DELEGATION_STATUS, type AuditeeStanding } from '@grc/workflow/auditeeLoop';

const RESP = cols(C.work_paper_responsibles);
const CC = cols(C.work_paper_cc_recipients);
const D = cols(C.auditee_delegations);
const WP = cols(C.work_papers);

export interface StandingActor {
  userId: string;
  isPlatformOwner: boolean;
  perms: string[];
}

/** The audit-side permission that reviews a released response. */
const REVIEW = 'WORK_PAPERS.review';

export async function auditeeStanding(
  db: Client,
  organizationId: string,
  workPaperId: string,
  actor: StandingActor,
): Promise<AuditeeStanding> {
  // One round trip for the three named ways in. The junctions carry no
  // organisation, so the two on the finding are scoped through it; the
  // delegation carries its own.
  const res = await db.execute({
    sql: `SELECT 'responsible' AS kind FROM work_paper_responsibles r
            JOIN work_papers wp ON wp.${WP.work_paper_id} = r.${RESP.work_paper_id}
             AND wp.${WP.organization_id} = ?
           WHERE r.${RESP.work_paper_id} = ? AND r.${RESP.user_id} = ?
           UNION ALL
          SELECT 'cc' AS kind FROM work_paper_cc_recipients c
            JOIN work_papers wp ON wp.${WP.work_paper_id} = c.${CC.work_paper_id}
             AND wp.${WP.organization_id} = ?
           WHERE c.${CC.work_paper_id} = ? AND c.${CC.user_id} = ?
           UNION ALL
          SELECT 'delegate' AS kind FROM auditee_delegations d
           WHERE d.${D.organization_id} = ? AND d.${D.work_paper_id} = ?
             AND d.${D.delegated_to} = ? AND d.${D.status} = ?`,
    args: [
      organizationId,
      workPaperId,
      actor.userId,
      organizationId,
      workPaperId,
      actor.userId,
      organizationId,
      workPaperId,
      actor.userId,
      DELEGATION_STATUS.ISSUED,
    ],
  });
  const kinds = new Set(res.rows.map((r) => String(r.kind)));
  return {
    isResponsible: kinds.has('responsible'),
    isCc: kinds.has('cc'),
    isDelegate: kinds.has('delegate'),
    isAudit: actor.isPlatformOwner || actor.perms.includes(REVIEW),
  };
}

/** Whether this person may see the finding's auditee thread at all. */
export function maySeeThread(standing: AuditeeStanding): boolean {
  return standing.isResponsible || standing.isCc || standing.isDelegate || standing.isAudit;
}
