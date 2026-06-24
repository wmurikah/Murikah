// Server endpoint — runs on-demand in the Worker (not prerendered).
export const prerender = false;

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { createDbClient } from '@/lib/db';
import { validateContact } from '@/lib/validation';
import { rateLimit } from '@/lib/rate-limit';
import { sendContactNotification } from '@/lib/email';
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

  // Honeypot: if the hidden field is filled, it's a bot. Feign success silently.
  if (typeof raw.company_website === 'string' && raw.company_website.trim() !== '') {
    return wantsJson
      ? json({ ok: true, message: "Thanks — we'll be in touch." })
      : seeOther('/contact?status=ok');
  }

  // Rate limit per IP (5 / hour).
  const rl = await rateLimit(env.CACHE, `contact:${clientIp(request)}`, 5, 3600);
  if (!rl.ok) {
    return wantsJson
      ? json(
          {
            ok: false,
            errors: [{ field: 'form', message: 'Too many submissions. Please try again later.' }],
          },
          429,
        )
      : seeOther('/contact?status=ratelimited');
  }

  // Validate (forgiving).
  const { data, errors } = validateContact(raw);
  if (!data) {
    return wantsJson ? json({ ok: false, errors }, 422) : seeOther('/contact?status=invalid');
  }

  // Persist to Turso.
  try {
    const db = createDbClient(env);
    await db.execute({
      sql: 'INSERT INTO leads (name, organisation, role, email, message, source) VALUES (?, ?, ?, ?, ?, ?)',
      args: [data.name, data.organisation, data.role, data.email, data.message, 'contact'],
    });
  } catch (error) {
    console.error('contact: failed to persist lead', error);
    return wantsJson
      ? json(
          {
            ok: false,
            errors: [
              {
                field: 'form',
                message: 'Something went wrong saving your message. Please email us directly.',
              },
            ],
          },
          500,
        )
      : seeOther('/contact?status=error');
  }

  // Notify by email — non-fatal; skipped when Resend isn't configured.
  await sendContactNotification(env, data);

  return wantsJson
    ? json({ ok: true, message: "Thanks — we'll be in touch shortly." })
    : seeOther('/contact?status=ok');
};
