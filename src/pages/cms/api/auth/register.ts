import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getCmsEnv } from '@/lib/cms/env';
import { getDb } from '@/lib/cms/db';
import { clientIp, json } from '@/lib/http';
import { rateLimit } from '@/lib/rate-limit';
import {
  normalizeIdentityEmail,
  classifyIdentityEmail,
  emailDomain,
} from '@/lib/cms/auth/identityPolicy';
import { createCustomerAccessRequest } from '@/lib/cms/repos/identityGateway';
import { verifyRegistrationGrant } from '@/lib/cms/auth/registrationGrant';

export const prerender = false;
export const POST: APIRoute = async ({ request }) => {
  const ip = clientIp(request);
  const limit = await rateLimit(env.CACHE, `cms-register:${ip}`, 5, 900);
  if (!limit.ok) return json({ ok: false, message: 'Too many requests. Try again later.' }, 429);
  let body: { email?: unknown; companyName?: unknown; contactName?: unknown; grant?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: 'Check the information and try again.' }, 400);
  }
  let verified;
  let cmsEnv;
  let db;
  try {
    cmsEnv = getCmsEnv();
    db = await getDb(cmsEnv);
    verified = await verifyRegistrationGrant(cmsEnv.sessionSecret, String(body.grant ?? ''));
  } catch {
    return json(
      { ok: false, message: 'Verify your company identity with Microsoft or Google first.' },
      400,
    );
  }
  const email = normalizeIdentityEmail(verified.email);
  let policy;
  try {
    policy = email ? await classifyIdentityEmail(db, email) : null;
  } catch {
    return json({ ok: false, message: 'Registration is temporarily unavailable.' }, 503);
  }
  if (!email || policy === 'CONSUMER')
    return json({ ok: false, message: 'Customer access requires a company email address.' }, 400);
  if (policy === 'INTERNAL_PROTECTED')
    return json(
      {
        ok: false,
        message:
          'Your Hass Petroleum account has not been provisioned. Contact your system administrator.',
      },
      400,
    );
  const companyName = String(body.companyName ?? '')
    .trim()
    .slice(0, 160);
  const contactName = String(body.contactName ?? '')
    .trim()
    .slice(0, 160);
  if (!companyName || !contactName)
    return json({ ok: false, message: 'Enter your name and company.' }, 400);
  try {
    await createCustomerAccessRequest(db, {
      email,
      emailDomain: emailDomain(email),
      provider: verified.provider,
      providerSubject: verified.subject,
      providerIssuer: verified.issuer,
      companyName,
      contactName,
      now: new Date(),
      ip,
      userAgent: request.headers.get('user-agent'),
    });
    const response = json(
      { ok: true, message: 'Your request has been received and is awaiting approval.' },
      202,
    );
    response.headers.set('cache-control', 'no-store');
    return response;
  } catch (error) {
    console.error('[cms.registration]', error);
    return json({ ok: false, message: 'Registration is temporarily unavailable.' }, 503);
  }
};
