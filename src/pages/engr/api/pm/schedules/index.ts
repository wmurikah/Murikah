export const prerender = false;

/** Create a PM schedule. Gate: pm.allocate. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { createSchedule, type ScheduleInput } from '@engr/repos/pm';
import { jsonResponse, wantsJson, redirectResponse, readBody, str } from '@engr/workflow/respond';

const TRUTHY = ['1', 'true', 'on'];

export function parseSchedule(body: Record<string, unknown>): ScheduleInput {
  const intervalRaw = str(body.interval_days).trim();
  const interval = intervalRaw ? Number(intervalRaw) : null;
  return {
    name: str(body.name),
    assetId: str(body.asset_id).trim() || null,
    stationId: str(body.station_id).trim() || null,
    categoryId: str(body.category_id).trim() || null,
    frequency: str(body.frequency).trim() || 'MONTHLY',
    intervalDays: interval != null && Number.isFinite(interval) ? interval : null,
    assignedContractorId: str(body.assigned_contractor_id).trim() || null,
    checklistTemplateId: str(body.checklist_template_id).trim() || null,
    slaId: str(body.sla_id).trim() || null,
    firstDueDate: str(body.first_due_date).trim() || null,
    isAutomated: TRUTHY.includes(str(body.is_automated).trim()),
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('pm.allocate')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, '/engr/pm', 'error=forbidden');
  }
  const input = parseSchedule(await readBody(request));
  const db = await getDb(getEngrEnv());
  const result = await createSchedule(db, { orgId: engr.orgId, userId: engr.userId }, input);
  if (result.ok) {
    return wantsJson(request)
      ? jsonResponse({ ok: true, id: result.id }, 201)
      : redirectResponse(request, `/engr/pm/schedules/${result.id}`);
  }
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, 422)
    : redirectResponse(request, '/engr/pm/schedules/new', `error=${result.code}`);
};
