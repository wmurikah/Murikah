export const prerender = false;

/**
 * Signup endpoint. Creates a fresh trial tenant (organisation + OWNER + TRIALING
 * subscription) from a name, work email, password and company name, then signs
 * the new owner in to their instance. A signup on a domain already in use is
 * blocked and the visitor is pointed at their administrator. Email is globally
 * unique. Public route (see routing.ts).
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createTrialTenant } from '@engr/repos/signup';
import { loadUserAuth } from '@engr/auth/rbac';
import { createSession } from '@engr/auth/session';

function redirect(location: string, cookie?: string): Response {
  const headers: Record<string, string> = { location };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status: 303, headers });
}

async function readForm(request: Request) {
  const form = await request.formData();
  return {
    fullName: String(form.get('full_name') ?? ''),
    email: String(form.get('email') ?? ''),
    password: String(form.get('password') ?? ''),
    companyName: String(form.get('company_name') ?? ''),
  };
}

export const POST: APIRoute = async ({ request }) => {
  const env = getEngrEnv();
  const db = await getDb(env);
  const input = await readForm(request);

  const result = await createTrialTenant(db, input);
  if (!result.ok) {
    if (result.code === 'domain' && result.domain) {
      return redirect(`/signup?error=domain&domain=${encodeURIComponent(result.domain)}`);
    }
    return redirect(`/signup?error=${result.code}`);
  }

  // Sign the new owner in to their instance.
  const { roles, perms } = await loadUserAuth(db, result.orgId, result.userId);
  const secure = new URL(request.url).protocol === 'https:';
  const cookie = await createSession(
    {
      sub: result.userId,
      org: result.orgId,
      orgSlug: result.orgSlug,
      orgName: result.orgName,
      userName: input.fullName.trim(),
      userEmail: input.email.trim().toLowerCase(),
      roles,
      perms,
    },
    env.sessionSecret,
    secure,
  );
  return redirect('/', cookie);
};
