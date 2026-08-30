import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCmsEnv } from '@/lib/cms/env';
import { getDb } from '@/lib/cms/db';
import { clientIp, json } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import { resetPassword } from '@/lib/cms/auth/passwordReset';

export const prerender = false;
export const POST: APIRoute = async ({ request }) => {
  const ip = clientIp(request);
  const limit = await rateLimit(env.CACHE, `cms-reset-complete:${ip}`, 10, 900);
  if (!limit.ok)
    return json({ ok: false, message: 'That reset link is invalid or has expired.' }, 400);
  let body: { token?: unknown; password?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: 'That reset link is invalid or has expired.' }, 400);
  }
  try {
    const cmsEnv = getCmsEnv();
    const db = await getDb(cmsEnv);
    const ok = await resetPassword(
      db,
      cmsEnv.sessionSecret,
      String(body.token ?? ''),
      String(body.password ?? ''),
      { ip, userAgent: request.headers.get('user-agent'), now: new Date() },
    );
    const response = ok
      ? json({ ok: true, message: 'Your password has been changed. You can now sign in.' }, 200)
      : json({ ok: false, message: 'That reset link is invalid or has expired.' }, 400);
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch {
    return json({ ok: false, message: 'Password reset is temporarily unavailable.' }, 503);
  }
};
