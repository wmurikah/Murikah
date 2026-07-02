export const prerender = false;

/**
 * RFQ collection endpoint.
 *  POST: engineer raises an RFQ and invites pre-qualified contractors. Gate:
 *        rfq.create.
 *  GET:  role-aware list. Engineers (rfq.view) get the org's RFQs; contractors
 *        (quotes.view) get the RFQs they are invited to.
 */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import {
  createRfqWithInvitations,
  listRfqsForEngineer,
  listRfqsForContractor,
} from '@engr/repos/rfqs';
import { contractorForUser } from '@engr/repos/techniciansPick';
import {
  jsonResponse,
  wantsJson,
  redirectResponse,
  str,
  toMinorUnits,
} from '@engr/workflow/respond';

interface CreateFields {
  requestId: string;
  dueDate: string | null;
  thresholdMinor: number | null;
  contractorIds: string[];
}

async function parseCreate(request: Request): Promise<CreateFields> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await request.json()) as Record<string, unknown>;
    const ids = Array.isArray(body.contractor_ids) ? body.contractor_ids.map((v) => str(v)) : [];
    return {
      requestId: str(body.request_id).trim(),
      dueDate: str(body.due_date).trim() || null,
      thresholdMinor: toMinorUnits(body.threshold),
      contractorIds: ids.filter(Boolean),
    };
  }
  const form = await request.formData();
  return {
    requestId: str(form.get('request_id')).trim(),
    dueDate: str(form.get('due_date')).trim() || null,
    thresholdMinor: toMinorUnits(form.get('threshold')),
    contractorIds: form
      .getAll('contractor_ids')
      .map((v) => str(v))
      .filter(Boolean),
  };
}

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('rfq.create')) {
    return wantsJson(request)
      ? jsonResponse({ error: 'forbidden' }, 403)
      : redirectResponse(request, '/engr/rfqs', 'error=forbidden');
  }

  const fields = await parseCreate(request);
  const back = `/engr/rfqs/new?request=${encodeURIComponent(fields.requestId)}`;
  if (!fields.requestId) {
    return wantsJson(request)
      ? jsonResponse({ error: 'validation', message: 'Missing request.' }, 422)
      : redirectResponse(request, '/engr/requests', 'error=validation');
  }

  const db = await getDb(getEngrEnv());
  const result = await createRfqWithInvitations(
    db,
    { orgId: engr.orgId, userId: engr.userId },
    fields,
  );

  if (result.ok) {
    const path = `/engr/rfqs/${result.rfqId}`;
    return wantsJson(request)
      ? jsonResponse({ ok: true, rfqId: result.rfqId, rfqNo: result.rfqNo }, 201)
      : redirectResponse(request, path);
  }
  const status = result.code === 'conflict' ? 409 : result.code === 'not_found' ? 404 : 422;
  return wantsJson(request)
    ? jsonResponse({ ok: false, error: result.code, message: result.message }, status)
    : redirectResponse(request, back, `error=${result.code}`);
};

export const GET: APIRoute = async ({ locals }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  const db = await getDb(getEngrEnv());

  if (engr.perms.includes('rfq.view')) {
    const rows = await listRfqsForEngineer(db, engr.orgId);
    return jsonResponse({ ok: true, rfqs: rows }, 200);
  }
  if (engr.perms.includes('quotes.view')) {
    const contractorId = await contractorForUser(db, engr.orgId, engr.userId);
    const rows = contractorId ? await listRfqsForContractor(db, engr.orgId, contractorId) : [];
    return jsonResponse({ ok: true, rfqs: rows }, 200);
  }
  return jsonResponse({ error: 'forbidden' }, 403);
};
