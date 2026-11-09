export const prerender = false;

import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { verifyPassword } from '@engr/auth/password';
import { mfaEnforced, setMfaEnforced } from '@engr/auth/mfaPolicy';
import { requireFreshMfa } from '@engr/auth/sensitiveAction';
import { jsonResponse, redirectResponse, wantsJson } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.isPlatformOwner) return jsonResponse({ error: 'forbidden' }, 403);

  const stepUp = requireFreshMfa(request, locals);
  if (stepUp) return stepUp;

  const form = await request.formData();
  const value = String(form.get('enforced') ?? '');
  if (value !== '0' && value !== '1') return jsonResponse({ error: 'invalid' }, 422);
  const password = String(form.get('current_password') ?? '');
  const db = await getDb(getEngrEnv());
  const account = await db.execute({
    sql: `SELECT password_hash FROM users WHERE id = ? AND org_id = ? AND status = 'ACTIVE' LIMIT 1`,
    args: [engr.userId, engr.homeOrgId],
  });
  const hash = String(account.rows[0]?.password_hash ?? '');
  if (!hash || !(await verifyPassword(password, hash))) {
    return wantsJson(request)
      ? jsonResponse({ error: 'invalid_credentials' }, 403)
      : redirectResponse(request, '/admin/security', 'error=password');
  }

  const next = value === '1';
  if ((await mfaEnforced(db, engr.orgId)) !== next) {
    await setMfaEnforced(db, { orgId: engr.orgId, actorUserId: engr.userId, enforced: next });
  }
  return wantsJson(request)
    ? jsonResponse({ ok: true, enforced: next }, 200)
    : redirectResponse(request, '/admin/security', 'saved=1');
};
