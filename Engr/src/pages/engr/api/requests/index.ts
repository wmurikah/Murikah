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
import { resolveEngineerInCharge } from '@engr/repos/engineerAssignments';
import { usersWithPermission } from '@engr/repos/approvers';
import { enqueue } from '@engr/notify';

interface Intake {
  stationId: string;
  categoryId: string | null;
  assetId: string | null;
  issue: string;
  natureOfBreakdown: string | null;
  priority: Priority;
  isRepeatCall: boolean;
  attachmentUrl: string | null;
  attachmentKind: string;
}

const ATTACHMENT_KINDS = new Set(['PHOTO', 'VIDEO', 'DOCUMENT']);

function fileNameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop();
    return (last && decodeURIComponent(last)) || 'attachment';
  } catch {
    return 'attachment';
  }
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
    const kind = String(body.attachment_kind ?? 'PHOTO').toUpperCase();
    return {
      stationId: String(body.station_id ?? '').trim(),
      categoryId: String(body.category_id ?? '').trim() || null,
      assetId: String(body.asset_id ?? '').trim() || null,
      issue: String(body.issue ?? '').trim(),
      natureOfBreakdown: String(body.nature_of_breakdown ?? '').trim() || null,
      priority: normalisePriority(String(body.priority ?? 'MEDIUM')),
      isRepeatCall: body.is_repeat_call === true || body.is_repeat_call === '1',
      attachmentUrl: String(body.attachment_url ?? '').trim() || null,
      attachmentKind: ATTACHMENT_KINDS.has(kind) ? kind : 'PHOTO',
    };
  }
  const form = await request.formData();
  const kind = String(form.get('attachment_kind') ?? 'PHOTO').toUpperCase();
  return {
    stationId: String(form.get('station_id') ?? '').trim(),
    categoryId: String(form.get('category_id') ?? '').trim() || null,
    assetId: String(form.get('asset_id') ?? '').trim() || null,
    issue: String(form.get('issue') ?? '').trim(),
    natureOfBreakdown: String(form.get('nature_of_breakdown') ?? '').trim() || null,
    priority: normalisePriority(String(form.get('priority') ?? 'MEDIUM')),
    isRepeatCall: form.get('is_repeat_call') != null,
    attachmentUrl: String(form.get('attachment_url') ?? '').trim() || null,
    attachmentKind: ATTACHMENT_KINDS.has(kind) ? kind : 'PHOTO',
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
        : redirect(request, '/requests/new?error=validation');
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
        : redirect(request, '/requests/new?error=station');
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

    // If an asset was chosen it must belong to this org and station, else drop it.
    let assetSafe: string | null = null;
    if (input.assetId) {
      const asset = await db.execute({
        sql: `SELECT id FROM assets WHERE id = ? AND org_id = ? AND station_id = ? AND deleted_at IS NULL LIMIT 1`,
        args: [input.assetId, engr.orgId, input.stationId],
      });
      assetSafe = asset.rows.length > 0 ? input.assetId : null;
    }

    // Route to the engineer in charge of this station or category, if any.
    const engineerId = await resolveEngineerInCharge(db, engr.orgId, input.stationId, categorySafe);

    const created = await createRequest(db, {
      orgId: engr.orgId,
      raisedBy: engr.userId,
      stationId: input.stationId,
      categoryId: categorySafe,
      assetId: assetSafe,
      issue: input.issue.slice(0, 200),
      natureOfBreakdown: input.natureOfBreakdown ? input.natureOfBreakdown.slice(0, 1000) : null,
      priority: input.priority,
      isRepeatCall: input.isRepeatCall,
      assignedEngineerId: engineerId,
    });

    // Record a photo or video attachment, if one was linked.
    if (input.attachmentUrl) {
      await db.execute({
        sql: `INSERT INTO attachments (org_id, entity_type, entity_id, kind, file_name, file_url, uploaded_by)
              VALUES (?, 'service_request', ?, ?, ?, ?, ?)`,
        args: [
          engr.orgId,
          created.id,
          input.attachmentKind,
          fileNameFromUrl(input.attachmentUrl),
          input.attachmentUrl,
          engr.userId,
        ],
      });
    }

    // Notify the routed engineer, or the managers when the scope has no engineer.
    const subject = `New request ${created.requestNo}`;
    const notifyBody = `${input.priority} priority: ${input.issue.slice(0, 140)}`;
    if (engineerId) {
      await enqueue(db, engr.orgId, {
        recipientType: 'user',
        recipientId: engineerId,
        templateKey: 'request.raised',
        subject,
        body: notifyBody,
        entityType: 'service_request',
        entityId: created.id,
      });
    } else {
      const managers = await usersWithPermission(db, engr.orgId, 'requests.accept');
      for (const managerId of managers) {
        await enqueue(db, engr.orgId, {
          recipientType: 'user',
          recipientId: managerId,
          templateKey: 'request.raised.unrouted',
          subject,
          body: `${notifyBody} (no engineer assigned to this scope)`,
          entityType: 'service_request',
          entityId: created.id,
        });
      }
    }

    return json
      ? jsonResponse({ ok: true, id: created.id, request_no: created.requestNo }, 201)
      : redirect(request, `/requests?created=${encodeURIComponent(created.requestNo)}`);
  } catch (err) {
    if (err instanceof Response) return err; // requirePermission threw a 403
    console.error('engr requests POST failed', err);
    return json
      ? jsonResponse({ error: 'server' }, 500)
      : redirect(request, '/requests/new?error=server');
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
