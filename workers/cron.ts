/**
 * Companion Cron Worker.
 *
 * The Astro Cloudflare adapter generates the site Worker and does not expose a
 * `scheduled` export, so the retention sweep lives in the app as the secured
 * endpoint /api/cron/sweep. This tiny Worker holds the Cron Trigger and calls
 * that endpoint on schedule with the shared secret. Deploy it separately:
 *   wrangler deploy --config wrangler.cron.jsonc
 */
interface CronEnv {
  /** Base URL of the deployed site, e.g. https://www.murikah.com */
  SITE_URL?: string;
  /** Shared secret, must match the site Worker's CRON_SECRET. */
  CRON_SECRET?: string;
}

export default {
  async scheduled(_event: ScheduledController, env: CronEnv, ctx: ExecutionContext): Promise<void> {
    const base = (env.SITE_URL ?? '').replace(/\/$/, '');
    if (!base || !env.CRON_SECRET) return;
    ctx.waitUntil(
      fetch(`${base}/api/cron/sweep`, {
        method: 'POST',
        // JSON content-type avoids the site's CSRF origin check on form posts.
        headers: { authorization: `Bearer ${env.CRON_SECRET}`, 'content-type': 'application/json' },
      })
        .then(() => undefined)
        .catch(() => undefined),
    );
  },
};
