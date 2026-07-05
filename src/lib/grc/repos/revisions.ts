/**
 * The append-only revision history of a work paper (work_paper_revisions): one
 * row per transition, carrying the revision number, the action, the from and to
 * status, comments, a changes summary, and the actor and time. This is the audit
 * trail shown on the detail. The write is used by the workflow executor inside
 * the same transaction as the status change, so history and state never drift.
 */
import type { Client, InStatement } from '@libsql/client/web';

export interface Revision {
  id: string;
  revisionNumber: number;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  comments: string | null;
  changesSummary: string | null;
  userId: string | null;
  userName: string | null;
  createdAt: string | null;
}

export async function listRevisions(
  db: Client,
  organizationId: string,
  workPaperId: string,
): Promise<Revision[]> {
  const res = await db.execute({
    sql: `SELECT wr.revision_id AS id, wr.revision_number, wr.action, wr.from_status, wr.to_status,
                 wr.comments, wr.changes_summary, wr.user_id, wr.user_name, wr.action_date AS created_at
            FROM work_paper_revisions wr
            JOIN work_papers wp ON wp.work_paper_id = wr.work_paper_id AND wp.organization_id = ?
           WHERE wr.work_paper_id = ?
        ORDER BY wr.revision_number DESC, wr.action_date DESC`,
    args: [organizationId, workPaperId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    revisionNumber: Number(r.revision_number ?? 0),
    action: String(r.action ?? ''),
    fromStatus: r.from_status == null ? null : String(r.from_status),
    toStatus: r.to_status == null ? null : String(r.to_status),
    comments: r.comments == null ? null : String(r.comments),
    changesSummary: r.changes_summary == null ? null : String(r.changes_summary),
    userId: r.user_id == null ? null : String(r.user_id),
    userName: r.user_name == null ? null : String(r.user_name),
    createdAt: r.created_at == null ? null : String(r.created_at),
  }));
}

export interface RevisionInput {
  workPaperId: string;
  revisionNumber: number;
  action: string;
  fromStatus: string;
  toStatus: string;
  comments: string | null;
  changesSummary: string | null;
  userId: string;
  userName: string;
}

/**
 * Build the INSERT statement for a revision, so the executor can batch it
 * atomically. work_paper_revisions has no organization_id of its own; the row is
 * tied to its (org-scoped) work paper, and the executor only reaches here after
 * resolving that work paper in the acting organisation.
 */
export function insertRevisionStatement(input: RevisionInput): InStatement {
  return {
    sql: `INSERT INTO work_paper_revisions
            (revision_id, work_paper_id, revision_number, action,
             from_status, to_status, comments, changes_summary, user_id, user_name, action_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      input.workPaperId,
      input.revisionNumber,
      input.action,
      input.fromStatus,
      input.toStatus,
      input.comments,
      input.changesSummary,
      input.userId,
      input.userName,
      new Date().toISOString(),
    ],
  };
}
