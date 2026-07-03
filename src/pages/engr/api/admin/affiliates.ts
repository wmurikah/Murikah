export const prerender = false;

/**
 * Affiliate write endpoint. Create when no id is posted, otherwise update. Only a
 * platform owner with org.manage may write, and the parent is always the caller's
 * home organisation (never a client value), so affiliates are created and edited
 * only under it.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createAffiliate, updateAffiliate } from '@engr/repos/adminAffiliates';
import { jsonResponse, wantsJson, readBody, str } from '@engr/workflow/respond';

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.isPlatformOwner || !engr.perms.includes('org.manage')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : seeOther('/admin/affiliates?error=forbidden');
  }

  const body = await readBody(request);
  const id = str(body.id).trim();
  const db = await getDb(getEngrEnv());
  const ctx = { groupId: engr.homeOrgId, userId: engr.userId };

  const result = id
    ? await updateAffiliate(db, ctx, id, {
        name: str(body.name).trim(),
        country: str(body.country).trim(),
        baseCurrency: str(body.base_currency).trim(),
        status: str(body.status).trim() || 'ACTIVE',
      })
    : await createAffiliate(db, ctx, {
        code: str(body.code).trim(),
        name: str(body.name).trim(),
        country: str(body.country).trim(),
        baseCurrency: str(body.base_currency).trim(),
      });

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, id ? 200 : 201)
      : seeOther('/admin/affiliates?saved=1');
  }
  const status = result.code === 'conflict' ? 409 : result.code === 'not_found' ? 404 : 422;
  if (wantsJson(request)) {
    return jsonResponse({ ok: false, error: result.code, message: result.message }, status);
  }
  return seeOther(`/admin/affiliates/${id || 'new'}?error=${result.code}`);
};
