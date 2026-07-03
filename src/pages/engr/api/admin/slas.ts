export const prerender = false;

/** SLAs admin write endpoint. Create when no id is posted, otherwise update. Gate: slas.manage. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createSla, updateSla, type SlaInput } from '@engr/repos/adminSlas';
import { jsonResponse, wantsJson, readBody, str } from '@engr/workflow/respond';

function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

/** Blank means not set (null); otherwise the raw number, which the repo validates. */
function hours(value: unknown): number | null {
  const n = str(value).trim();
  return n === '' ? null : Number(n);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('slas.manage')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : seeOther('/admin/slas?error=forbidden');
  }

  const body = await readBody(request);
  const id = str(body.id).trim();
  const input: SlaInput = {
    name: str(body.name).trim(),
    responseHours: hours(body.response_hours),
    resolutionHours: hours(body.resolution_hours),
    isDefault: str(body.is_default) === 'on' || str(body.is_default) === '1',
  };

  const db = await getDb(getEngrEnv());
  const ctx = { orgId: engr.orgId, userId: engr.userId };
  const result = id ? await updateSla(db, ctx, id, input) : await createSla(db, ctx, input);

  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, id ? 200 : 201)
      : seeOther('/admin/slas?saved=1');
  }
  const status = result.code === 'conflict' ? 409 : result.code === 'not_found' ? 404 : 422;
  if (wantsJson(request)) {
    return jsonResponse({ ok: false, error: result.code, message: result.message }, status);
  }
  return seeOther(`/admin/slas/${id || 'new'}?error=${result.code}`);
};
