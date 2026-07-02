export const prerender = false;

/**
 * Service request endpoint.
 *
 * POST creates a request (gate requests.create): it validates input server-side,
 * checks the station and any category belong to the caller's org, allocates the
 * next request number, inserts the request and its audit_logs row atomically,
 * then redirects a browser form to the queue or returns JSON to an API client.
 *
 * GET returns the org-scoped queue as JSON (gate requests.view).
 *
 * The org and the acting user come only from the verified session, never from
 * the request body.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { requirePermission } from '@engr/auth/rbac';
import { createRequest, listQueue, PRIORITIES, type Priority } from '@engr/repos/requests';

interface Intake {
  stationId: string;
  categoryId: string | null;
  issue: string;
  natureOfBreakdown: string | null;
  priority: Priority;
  isRepeatCall: boolean;
}

function wantsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('application/json');
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function redirect(request: Request, path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: new URL(path, request.url).toString() },
  });
}

function normalisePriority(value: string): Priority {
  const upper = value.trim().toUpperCase();
  return (PRIORITIES as string[]).includes(upper) ? (upper as Priority) : 'MEDIUM';
}

async function readIntake(request: Request): Promise<Intake> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await request.json()) as Record<string, unknown>;
    return {
      stationId: String(body.station_id ?? '').trim(),
      categoryId: String(body.category_id ?? '').trim() || null,
      issue: String(body.issue ?? '').trim(),
      natureOfBreakdown: String(body.nature_of_breakdown ?? '').trim() || null,
      priority: normalisePriority(String(body.priority ?? 'MEDIUM')),
      isRepeatCall: body.is_repeat_call === true || body.is_repeat_call === '1',
    };
  }
  const form = await request.formData();
  return {
    stationId: String(form.get('station_id') ?? '').trim(),
    categoryId: String(form.get('category_id') ?? '').trim() || null,
    issue: String(form.get('issue') ?? '').trim(),
    natureOfBreakdown: String(form.get('nature_of_breakdown') ?? '').trim() || null,
    priority: normalisePriority(String(form.get('priority') ?? 'MEDIUM')),
    isRepeatCall: form.get('is_repeat_call') != null,
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const json = wantsJson(request);

  try {
    requirePermission(locals, 'requests.create');

    const input = await readIntake(request);
    if (!input.stationId || !input.issue) {
      return json
        ? jsonResponse({ error: 'validation' }, 422)
        : redirect(request, '/engr/requests/new?error=validation');
    }

    const db = await getDb(getEngrEnv());

    // The station must belong to this org, so a forged id cannot cross tenants.
    const station = await db.execute({
      sql: `SELECT id FROM stations WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      args: [input.stationId, engr.orgId],
    });
    if (station.rows.length === 0) {
      return json
        ? jsonResponse({ error: 'station' }, 422)
        : redirect(request, '/engr/requests/new?error=station');
    }

    // If a category was chosen it must belong to this org too, otherwise drop it.
    let categorySafe: string | null = null;
    if (input.categoryId) {
      const category = await db.execute({
        sql: `SELECT id FROM asset_categories WHERE id = ? AND org_id = ? LIMIT 1`,
        args: [input.categoryId, engr.orgId],
      });
      categorySafe = category.rows.length > 0 ? input.categoryId : null;
    }

    const created = await createRequest(db, {
      orgId: engr.orgId,
      raisedBy: engr.userId,
      stationId: input.stationId,
      categoryId: categorySafe,
      assetId: null,
      issue: input.issue.slice(0, 200),
      natureOfBreakdown: input.natureOfBreakdown ? input.natureOfBreakdown.slice(0, 1000) : null,
      priority: input.priority,
      isRepeatCall: input.isRepeatCall,
    });

    return json
      ? jsonResponse({ ok: true, id: created.id, request_no: created.requestNo }, 201)
      : redirect(request, `/engr/requests?created=${encodeURIComponent(created.requestNo)}`);
  } catch (err) {
    if (err instanceof Response) return err; // requirePermission threw a 403
    console.error('engr requests POST failed', err);
    return json
      ? jsonResponse({ error: 'server' }, 500)
      : redirect(request, '/engr/requests/new?error=server');
  }
};

export const GET: APIRoute = async ({ locals, url }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);

  try {
    requirePermission(locals, 'requests.view');
    const scope = url.searchParams.get('scope') === 'all' ? 'all' : 'mine';
    const db = await getDb(getEngrEnv());
    const requests = await listQueue(db, engr.orgId, engr.userId, scope);
    return jsonResponse({ ok: true, scope, requests }, 200);
  } catch (err) {
    if (err instanceof Response) return err;
    console.error('engr requests GET failed', err);
    return jsonResponse({ error: 'server' }, 500);
  }
};
