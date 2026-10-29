export const prerender = false;

/**
 * Engineer-in-charge assignment endpoint for the acting organisation. Create an
 * assignment (an engineer owns a station or a category), or remove one. Only a
 * super-admin with settings.manage may write. The organisation is always the
 * acting organisation from the session, never a client value.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createAssignment, deleteAssignment } from '@engr/repos/engineerAssignments';
import { jsonResponse, wantsJson, str } from '@engr/workflow/respond';

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('settings.manage')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : seeOther('/admin/engineers?error=forbidden');
  }

  const form = await request.formData();
  const db = await getDb(getEngrEnv());
  const ctx = { orgId: engr.orgId, userId: engr.userId };
  const deleteId = str(form.get('delete_id')).trim();

  const result = deleteId
    ? await deleteAssignment(db, ctx, deleteId)
    : await createAssignment(db, ctx, {
        engineerUserId: str(form.get('engineer_user_id')).trim(),
        scopeType: str(form.get('scope_type')).trim(),
        stationId: str(form.get('station_id')).trim() || null,
        categoryId: str(form.get('category_id')).trim() || null,
      });

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, deleteId ? 200 : 201)
      : seeOther('/admin/engineers?saved=1');
  }
  const status = result.code === 'not_found' ? 404 : 422;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : seeOther(`/admin/engineers?error=${result.code}`);
};
