/**
 * Overdue maintenance, the port of the source's daily trigger. The worker's
 * scheduled() handler calls updateOverdueStatuses: for past-due, non-terminal
 * plans it recomputes `days_overdue` and moves the status to Overdue. This is a
 * system maintenance job across every organisation (each row carries its
 * organization_id, so it never crosses tenants); it is not a user request.
 *
 * Statuses that move to Overdue are the active ones (Not Due, Pending, In
 * Progress); a plan already in Overdue has its day count refreshed; a done or
 * rejected plan is left untouched.
 */
import type { Client } from '@libsql/client/web';

export interface OverdueResult {
  becameOverdue: number;
  refreshed: number;
}

export async function updateOverdueStatuses(db: Client): Promise<OverdueResult> {
  // Refresh the day count on plans already overdue.
  const refreshed = await db.execute({
    sql: `UPDATE action_plans
             SET days_overdue = CAST(julianday('now') - julianday(due_date) AS INTEGER)
           WHERE due_date IS NOT NULL AND status = 'OVERDUE' AND due_date < date('now')`,
    args: [],
  });

  // Move newly past-due active plans to Overdue and set the day count.
  const became = await db.execute({
    sql: `UPDATE action_plans
             SET status = 'OVERDUE',
                 days_overdue = CAST(julianday('now') - julianday(due_date) AS INTEGER),
                 updated_at = ?
           WHERE due_date IS NOT NULL AND due_date < date('now')
             AND status IN ('NOT_DUE', 'PENDING', 'IN_PROGRESS')`,
    args: [new Date().toISOString()],
  });

  return {
    becameOverdue: became.rowsAffected ?? 0,
    refreshed: refreshed.rowsAffected ?? 0,
  };
}
