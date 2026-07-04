/**
 * The append-only history of an action plan (action_plan_history): one row per
 * transition and delegation, with the previous and new status, comments, and the
 * actor and time. Shown on the detail; written by the executor in the same batch
 * as the change so history and state never drift.
 */
import type { Client, InStatement } from '@libsql/client/web';

export interface HistoryRow {
  id: string;
  previousStatus: string | null;
  newStatus: string | null;
  comments: string | null;
  userId: string | null;
  userName: string | null;
  createdAt: string | null;
}

export async function listHistory(
  db: Client,
  organizationId: string,
  actionPlanId: string,
): Promise<HistoryRow[]> {
  const res = await db.execute({
    sql: `SELECT history_id AS id, previous_status, new_status, comments, user_id, user_name, created_at
            FROM action_plan_history
           WHERE organization_id = ? AND action_plan_id = ?
        ORDER BY created_at DESC`,
    args: [organizationId, actionPlanId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    previousStatus: r.previous_status == null ? null : String(r.previous_status),
    newStatus: r.new_status == null ? null : String(r.new_status),
    comments: r.comments == null ? null : String(r.comments),
    userId: r.user_id == null ? null : String(r.user_id),
    userName: r.user_name == null ? null : String(r.user_name),
    createdAt: r.created_at == null ? null : String(r.created_at),
  }));
}

export interface HistoryInput {
  actionPlanId: string;
  previousStatus: string;
  newStatus: string;
  comments: string | null;
  userId: string;
  userName: string;
}

/** The INSERT statement for a history row, so the executor can batch it atomically. */
export function insertHistoryStatement(organizationId: string, input: HistoryInput): InStatement {
  return {
    sql: `INSERT INTO action_plan_history
            (history_id, organization_id, action_plan_id, previous_status, new_status, comments, user_id, user_name, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      organizationId,
      input.actionPlanId,
      input.previousStatus,
      input.newStatus,
      input.comments,
      input.userId,
      input.userName,
      new Date().toISOString(),
    ],
  };
}
