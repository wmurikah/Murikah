/** Persistent execution records for Cloudflare scheduled maintenance. */
import type { Client } from '@libsql/client/web';

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function runRecordedJob<T>(
  db: Client,
  name: string,
  task: () => Promise<T>,
): Promise<T | null> {
  const started = Date.now();
  const now = new Date().toISOString();
  try {
    const result = await task();
    await db.execute({
      sql: `INSERT INTO scheduled_jobs
              (job_id, job_name, is_enabled, last_run_at, last_run_status,
               last_run_duration_ms, last_error, updated_at)
            VALUES (?, ?, 1, ?, 'SUCCESS', ?, NULL, ?)
            ON CONFLICT(job_id) DO UPDATE /* upsert */ SET
              last_run_at = excluded.last_run_at,
              last_run_status = excluded.last_run_status,
              last_run_duration_ms = excluded.last_run_duration_ms,
              last_error = NULL,
              updated_at = excluded.updated_at`,
      args: [`system:${name}`, name, now, Date.now() - started, new Date().toISOString()],
    });
    return result;
  } catch (error) {
    const message = errorText(error).slice(0, 2000);
    console.error(`[grc.scheduled.${name}]`, error);
    try {
      await db.execute({
        sql: `INSERT INTO scheduled_jobs
                (job_id, job_name, is_enabled, last_run_at, last_run_status,
                 last_run_duration_ms, last_error, updated_at)
              VALUES (?, ?, 1, ?, 'FAILED', ?, ?, ?)
              ON CONFLICT(job_id) DO UPDATE /* upsert */ SET
                last_run_at = excluded.last_run_at,
                last_run_status = excluded.last_run_status,
                last_run_duration_ms = excluded.last_run_duration_ms,
                last_error = excluded.last_error,
                updated_at = excluded.updated_at`,
        args: [
          `system:${name}`,
          name,
          now,
          Date.now() - started,
          message,
          new Date().toISOString(),
        ],
      });
    } catch (recordError) {
      console.error(`[grc.scheduled.${name}.record]`, recordError);
    }
    return null;
  }
}
