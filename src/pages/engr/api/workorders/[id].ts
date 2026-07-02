export const prerender = false;

/** One work order with its joins. Gate: workorder.view. Org-scoped. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { getWorkOrderDetail } from '@engr/repos/workOrders';
import { jsonResponse } from '@engr/workflow/respond';

export const GET: APIRoute = async ({ locals, params }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('workorder.view')) return jsonResponse({ error: 'forbidden' }, 403);
  const id = params.id;
  if (!id) return jsonResponse({ error: 'invalid' }, 400);

  const db = await getDb(getEngrEnv());
  const workOrder = await getWorkOrderDetail(db, engr.orgId, id);
  if (!workOrder) return jsonResponse({ error: 'not_found' }, 404);
  return jsonResponse({ ok: true, workOrder }, 200);
};
