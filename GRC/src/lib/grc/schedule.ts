/**
 * The five-minute dispatcher also owns the once-daily maintenance window so
 * GRC consumes one Cloudflare Cron Trigger instead of two. `scheduledTime` is
 * the time Cloudflare intended the invocation to run, so a delayed invocation
 * still identifies the 03:00 UTC slot correctly.
 */
export function shouldRunDailyMaintenance(scheduledTime: number): boolean {
  const scheduled = new Date(scheduledTime);
  return scheduled.getUTCHours() === 3 && scheduled.getUTCMinutes() === 0;
}
