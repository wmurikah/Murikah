export const prerender = false;

/**
 * Amend a sealed LPO. Gate: workorder.create and workorder.assign. This opens a
 * new draft as version n plus one, linked by supersedes_id / superseded_by_id,
 * with the covered work orders moved onto it; the sealed original is untouched.
 * The raiser then adjusts the new draft and re-issues it.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { amendLpo } from '@engr/repos/lpoAudit';
import { jsonResponse, wantsJson, redirectResponse } from '@engr/workflow/respond';

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/lpos/${id}`;

  if (!(engr.perms.includes('workorder.create') && engr.perms.includes('workorder.assign'))) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const db = await getDb(getEngrEnv());
  const result = await amendLpo(db, { orgId: engr.orgId, userId: engr.userId }, id);
  if (result.ok) {
    // Send the raiser to the new draft to adjust and re-issue.
    return wantsJson(request)
      ? jsonResponse({ ok: true, lpoId: result.lpoId, lpoNo: result.lpoNo }, 201)
      : redirectResponse(request, `/lpos/${result.lpoId}`, 'amended=1');
  }
  const status = result.code === 'not_found' ? 404 : result.code === 'conflict' ? 409 : 422;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, back, `error=${result.code}`);
};
