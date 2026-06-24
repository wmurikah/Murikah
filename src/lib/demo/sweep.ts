/**
 * Retention sweep. Deletes demo data and old sessions past 24 hours, and
 * prunes assistant logs past 30 days. Invoked by the secret-guarded
 * /api/cron/sweep endpoint, which the companion Cron Worker calls on schedule
 * (see workers/cron.ts and the README). Safe to run repeatedly.
 */
import { createDbClient, type DbEnv } from '@/lib/db';
import { RETENTION } from './config';

export async function runRetentionSweep(env: DbEnv): Promise<Record<string, number>> {
  const db = createDbClient(env); // throws if Turso not configured; caller handles

  const demoCutoff = `datetime('now', '-${RETENTION.demoHours} hours')`;
  const assistantCutoff = `datetime('now', '-${RETENTION.assistantDays} days')`;
  const counts: Record<string, number> = {};

  const sweep = async (label: string, sql: string) => {
    try {
      const r = await db.execute(sql);
      counts[label] = r.rowsAffected ?? 0;
    } catch {
      counts[label] = -1; // table may not exist yet; keep going
    }
  };

  // Session-scoped demo data and the sessions themselves.
  await sweep('demo_invoices', `DELETE FROM demo_invoices WHERE created_at < ${demoCutoff}`);
  await sweep(
    'demo_workflow_runs',
    `DELETE FROM demo_workflow_runs WHERE created_at < ${demoCutoff}`,
  );
  await sweep('demo_crm_events', `DELETE FROM demo_crm_events WHERE created_at < ${demoCutoff}`);
  await sweep(
    'demo_crm_contacts',
    `DELETE FROM demo_crm_contacts WHERE created_at < ${demoCutoff}`,
  );
  await sweep('demo_sessions', `DELETE FROM demo_sessions WHERE created_at < ${demoCutoff}`);

  // Assistant audit logs (messages first, then conversations).
  await sweep(
    'assistant_messages',
    `DELETE FROM assistant_messages WHERE created_at < ${assistantCutoff}`,
  );
  await sweep(
    'assistant_conversations',
    `DELETE FROM assistant_conversations WHERE created_at < ${assistantCutoff}`,
  );

  return counts;
}
