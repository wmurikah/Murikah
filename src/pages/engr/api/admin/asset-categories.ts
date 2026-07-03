export const prerender = false;

/** Asset categories admin write endpoint. Create when no id is posted, otherwise update. Gate: assets.manage. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createCategory, updateCategory, type CategoryInput } from '@engr/repos/adminCategories';
import { jsonResponse, wantsJson, readBody, str } from '@engr/workflow/respond';

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('assets.manage')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : seeOther('/admin/asset-categories?error=forbidden');
  }

  const body = await readBody(request);
  const id = str(body.id).trim();
  const input: CategoryInput = {
    code: str(body.code).trim(),
    name: str(body.name).trim(),
    parentId: str(body.parent_id).trim() || null,
  };

  const db = await getDb(getEngrEnv());
  const ctx = { orgId: engr.orgId, userId: engr.userId };
  const result = id
    ? await updateCategory(db, ctx, id, input)
    : await createCategory(db, ctx, input);

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, id ? 200 : 201)
      : seeOther('/admin/asset-categories?saved=1');
  }
  const status = result.code === 'conflict' ? 409 : result.code === 'not_found' ? 404 : 422;
  if (wantsJson(request)) {
    return jsonResponse({ ok: false, error: result.code, message: result.message }, status);
  }
  return seeOther(`/admin/asset-categories/${id || 'new'}?error=${result.code}`);
};
