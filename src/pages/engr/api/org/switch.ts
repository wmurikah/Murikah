export const prerender = false;

/**
 * Switch the acting organisation. Only a platform owner may switch, and only to
 * an organisation in the set the middleware resolved for this request
 * (locals.engr.switchable, every live organisation), so a forged form value
 * cannot reach anything outside it. The switch is audited under the owner's home
 * organisation, then the acting-org cookie is set and the browser is sent to the
 * dashboard of the now-acting organisation.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createActingCookie } from '@engr/auth/actingOrg';
import { jsonResponse, wantsJson, readBody, str } from '@engr/workflow/respond';

function seeOther(location: string, cookie?: string): Response {
  const headers: Record<string, string> = { location };
  if (cookie) headers['set-cookie'] = cookie;
  return new Response(null, { status: 303, headers });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.isPlatformOwner) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : seeOther('/?error=switch');
  }

  const body = await readBody(request);
  const target = str(body.org_id).trim();
  const allowed = engr.switchable.some((s) => s.id === target);
  if (!target || !allowed) {
    return wantsJson(request)
      ? jsonResponse(
          { error: 'forbidden', message: 'That organisation is not one you may act inside.' },
          403,
        )
      : seeOther('/?error=switch');
  }

  const env = getEngrEnv();
  const db = await getDb(env);
  await db.execute({
    sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
          VALUES (?, ?, 'org.switch', 'organisation', ?, ?)`,
    args: [engr.homeOrgId, engr.userId, target, JSON.stringify({ from: engr.orgId, to: target })],
  });

  const secure = new URL(request.url).protocol === 'https:';
  const cookie = await createActingCookie(target, env.sessionSecret, secure);
  if (wantsJson(request)) {
    return new Response(JSON.stringify({ ok: true, orgId: target }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': cookie },
    });
  }
  return seeOther('/', cookie);
};
