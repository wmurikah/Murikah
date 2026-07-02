export const prerender = false;

/**
 * Edit a PM schedule, or change its status. Gate: pm.allocate. An `action` of
 * pause, resume or archive changes status; otherwise the body is a full edit,
 * which also applies the reschedule rule when the due date moves.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { updateSchedule, setScheduleStatus } from '@engr/repos/pm';
import { parseSchedule } from './index';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

function statusFor(code: string): number {
  return code === 'not_found' ? 404 : code === 'conflict' ? 409 : 422;
}

export const POST: APIRoute = async ({ request, locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);
  const back = `/engr/pm/schedules/${id}`;

  if (!engr.perms.includes('pm.allocate')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, back, 'error=forbidden');
  }

  const body = await readBody(request);
  const ctx = { orgId: engr.orgId, userId: engr.userId };
  const db = await getDb(getEngrEnv());
  const action = str(body.action).trim();

  if (action === 'pause' || action === 'resume' || action === 'archive') {
    const status = action === 'resume' ? 'ACTIVE' : action === 'pause' ? 'PAUSED' : 'ARCHIVED';
    const result = await setScheduleStatus(db, ctx, id, status);
    if (result.ok) {
      return wantsJson(request)
        ? jsonResponse({ ok: true }, 200)
        : redirectResponse(request, '/engr/pm');
    }
    return wantsJson(request)
      ? jsonResponse(
          { ok: false, error: result.code, message: result.message },
          statusFor(result.code),
        )
      : redirectResponse(request, back, `error=${result.code}`);
  }

  const result = await updateSchedule(db, ctx, id, parseSchedule(body));
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, 200)
      : redirectResponse(request, back, 'saved=1');
  }
  return wantsJson(request)
    ? jsonResponse(
        { ok: false, error: result.code, message: result.message },
        statusFor(result.code),
      )
    : redirectResponse(request, back, `error=${result.code}`);
};
