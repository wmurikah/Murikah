// Server endpoint, runs on-demand in the Worker (not prerendered).
export const prerender = false;

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createDbClient } from '@/lib/db';
import { validateSubscribe } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { json, seeOther, clientIp } from '@/lib/http';

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      return (await request.json()) as Record<string, unknown>;
    }
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  } catch {
    return {};
  }
}

export const POST: APIRoute = async ({ request }) => {
  const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');

  const raw = await parseBody(request);

  // Honeypot.
  if (typeof raw.company_website === 'string' && raw.company_website.trim() !== '') {
    return wantsJson ? json({ ok: true, message: 'Subscribed.' }) : seeOther('/?status=subscribed');
  }

  const rl = await rateLimit(env.CACHE, `subscribe:${clientIp(request)}`, 5, 3600);
  if (!rl.ok) {
    return wantsJson
      ? json(
          {
            ok: false,
            errors: [{ field: 'email', message: 'Too many attempts. Please try again later.' }],
          },
          429,
        )
      : seeOther('/?status=ratelimited');
  }

  const { data, errors } = validateSubscribe(raw);
  if (!data) {
    return wantsJson ? json({ ok: false, errors }, 422) : seeOther('/?status=invalid');
  }

  try {
    const db = createDbClient(env);
    // INSERT OR IGNORE, re-subscribing is idempotent, not an error.
    await db.execute({
      sql: 'INSERT OR IGNORE INTO subscribers (email, source) VALUES (?, ?)',
      args: [data.email, data.source],
    });
  } catch (error) {
    console.error('subscribe: failed to persist subscriber', error);
    return wantsJson
      ? json(
          {
            ok: false,
            errors: [{ field: 'email', message: 'Something went wrong. Please try again.' }],
          },
          500,
        )
      : seeOther('/?status=error');
  }

  return wantsJson
    ? json({ ok: true, message: 'Subscribed, thank you.' })
    : seeOther('/?status=subscribed');
};
