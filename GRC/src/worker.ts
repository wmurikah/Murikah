import astro from '@astrojs/cloudflare/entrypoints/server';
import { getGrcEnv } from './lib/grc/env';
import { getDb as getGrcDb } from './lib/grc/db';
import { updateOverdueStatuses } from './lib/grc/repos/overdue';
import { getGrcDeliveryEnv } from './lib/grc/notify/env';
import { runGrcDispatch } from './lib/grc/notify/dispatch';
import {
  runStaleReminders,
  runOverdueReminders,
  runDueSoonReminders,
} from './lib/grc/notify/reminders';
import { runEvidenceMigration } from './lib/grc/storage/migrate';
import { runEvidencePurge } from './lib/grc/storage/purge';
import { anchorAuditLog } from './lib/grc/repos/auditAnchor';
import { runRecordedJob } from './lib/grc/repos/scheduledJobs';
import { shouldRunDailyMaintenance } from './lib/grc/schedule';

import { systemClock } from './lib/shared/time';

const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "require-trusted-types-for 'script'",
].join('; ');

/** Security policy is applied in code so every deployment receives it, rather
 * than depending on a manually configured Cloudflare dashboard rule. CSP starts
 * in report-only mode while existing inline scripts migrate to nonces/hashes. */
function withSecurityHeaders(response: Response, requestUrl: URL, host: string): Response {
  const result = new Response(response.body, response);
  result.headers.set('content-security-policy-report-only', CSP_REPORT_ONLY);
  result.headers.set('cross-origin-opener-policy', 'same-origin-allow-popups');
  result.headers.set('cross-origin-resource-policy', 'same-origin');
  result.headers.set(
    'permissions-policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  );
  result.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  result.headers.set('x-content-type-options', 'nosniff');
  result.headers.set('x-frame-options', 'DENY');
  result.headers.set('x-permitted-cross-domain-policies', 'none');
  if (
    requestUrl.protocol === 'https:' &&
    (host === 'grc.murikah.com' || host.endsWith('.grc.murikah.com'))
  ) {
    result.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  return result;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const host = (request.headers.get('host') ?? url.host).split(':')[0].toLowerCase();
    if (url.pathname.startsWith('/__astro')) {
      return withSecurityHeaders(await astro.fetch(request, env, ctx), url, host);
    }
    if (
      !(
        host === 'grc.murikah.com' ||
        host.endsWith('.grc.murikah.com') ||
        host === 'grc.localhost' ||
        host.endsWith('.grc.localhost') ||
        host === 'localhost' ||
        host === '127.0.0.1'
      )
    )
      return withSecurityHeaders(new Response('Not found', { status: 404 }), url, host);
    if (
      !url.pathname.startsWith('/_') &&
      !/\.[a-z0-9]+$/i.test(url.pathname) &&
      url.pathname !== '/grc' &&
      !url.pathname.startsWith('/grc/')
    )
      url.pathname = '/grc' + (url.pathname === '/' ? '' : url.pathname);
    const response = await astro.fetch(new Request(url, request), env, ctx);
    const result = withSecurityHeaders(response, url, host);
    result.headers.set('x-mrk-host', host);
    result.headers.set('x-mrk-branch', 'grc-app');
    return result;
  },
  async scheduled(
    controller: ScheduledController,
    _env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const grcEnv = getGrcEnv();
          const grcDb = await getGrcDb(grcEnv);
          await runRecordedJob(grcDb, 'notification-dispatch', () =>
            runGrcDispatch(grcDb, getGrcDeliveryEnv(), grcEnv.sessionSecret, systemClock, {
              limit: 200,
            }),
          );
          await runRecordedJob(grcDb, 'audit-log-anchor', () => anchorAuditLog(grcDb));
          if (!shouldRunDailyMaintenance(controller.scheduledTime)) return;

          await runRecordedJob(grcDb, 'overdue-statuses', () => updateOverdueStatuses(grcDb));
          await runRecordedJob(grcDb, 'stale-reminders', () =>
            runStaleReminders(grcDb, systemClock),
          );
          await runRecordedJob(grcDb, 'due-soon-reminders', () =>
            runDueSoonReminders(grcDb, systemClock),
          );
          await runRecordedJob(grcDb, 'overdue-reminders', () =>
            runOverdueReminders(grcDb, systemClock),
          );
          await runRecordedJob(grcDb, 'evidence-migration', () => runEvidenceMigration(grcDb, 25));
          await runRecordedJob(grcDb, 'evidence-purge', () =>
            runEvidencePurge(grcDb, new Date(controller.scheduledTime), 50),
          );
        } catch (error) {
          // Database/bootstrap failures cannot be recorded in scheduled_jobs,
          // but must still reach Cloudflare observability.
          console.error('[grc.scheduled.bootstrap]', error);
        }
      })(),
    );
  },
};
