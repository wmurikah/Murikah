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
    sql: `SELECT h.history_id AS id, h.from_status AS previous_status, h.to_status AS new_status,
                 h.comments, h.user_id, h.user_name, h.action_date AS created_at
            FROM action_plan_history h
            JOIN action_plans ap ON ap.action_plan_id = h.action_plan_id AND ap.organization_id = ?
           WHERE h.action_plan_id = ?
        ORDER BY h.action_date DESC`,
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

/**
 * The INSERT statement for a history row, so the executor can batch it
 * atomically. action_plan_history has no organization_id of its own (it is tied
 * to its org-scoped plan) and records who and when as from_status/to_status and
 * action_date. The `action` column is stamped with the target status.
 */
export function insertHistoryStatement(input: HistoryInput): InStatement {
  return {
    sql: `INSERT INTO action_plan_history
            (history_id, action_plan_id, action, from_status, to_status, comments, user_id, user_name, action_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      input.actionPlanId,
      input.newStatus,
      input.previousStatus,
      input.newStatus,
      input.comments,
      input.userId,
      input.userName,
      new Date().toISOString(),
    ],
  };
}
