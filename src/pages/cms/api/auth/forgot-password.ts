import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCmsEnv } from '@/lib/cms/env';
import { getDb } from '@/lib/cms/db';
import { clientIp, json } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { requestPasswordReset } from '@/lib/cms/auth/passwordReset';

export const prerender = false;
const MESSAGE = 'If an account is eligible, password reset instructions will be sent.';

export const POST: APIRoute = async ({ request, url }) => {
  const ip = clientIp(request);
  const limit = await rateLimit(env.CACHE, `cms-reset:${ip}`, 5, 900);
  if (!limit.ok) return json({ message: MESSAGE }, 202);
  let email = '';
  try {
    email = String(((await request.json()) as { email?: unknown }).email ?? '');
  } catch {
    return json({ message: MESSAGE }, 202);
  }
  try {
    const cmsEnv = getCmsEnv();
    const db = await getDb(cmsEnv);
    const outcome = await requestPasswordReset(db, cmsEnv.sessionSecret, email, {
      ip,
      userAgent: request.headers.get('user-agent'),
      now: new Date(),
    });
    if (outcome.issued && env.CMS_AUTH_MAIL_ENDPOINT && env.CMS_AUTH_MAIL_SECRET) {
      const resetUrl = new URL('/reset-password', url.origin);
      resetUrl.searchParams.set('token', outcome.rawToken);
      await fetch(env.CMS_AUTH_MAIL_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.CMS_AUTH_MAIL_SECRET}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          template: 'cms-password-reset',
          to: email.trim().toLowerCase(),
          resetUrl: resetUrl.toString(),
        }),
      });
    }
  } catch {
    // Keep the anonymous response generic; operational delivery is monitored by the mail service.
  }
  const response = json({ message: MESSAGE }, 202);
  response.headers.set('cache-control', 'no-store');
  return response;
};
