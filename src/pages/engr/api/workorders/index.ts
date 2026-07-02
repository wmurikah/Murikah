export const prerender = false;

/** Role-aware work-order list. Gate: workorder.view. Org-scoped. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import {
  listForEngineer,
  listForContractor,
  listForTechnician,
  listForStationManager,
  type WorkOrderListRow,
} from '@engr/repos/workOrders';
import { jsonResponse } from '@engr/workflow/respond';

export const GET: APIRoute = async ({ locals, url }) => {
  const engr = locals.engr;
  if (!engr) return jsonResponse({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('workorder.view')) return jsonResponse({ error: 'forbidden' }, 403);

  const view = url.searchParams.get('view') ?? 'engineer';
  const status = url.searchParams.get('status') ?? undefined;
  const db = await getDb(getEngrEnv());

  let rows: WorkOrderListRow[];
  if (view === 'contractor') rows = await listForContractor(db, engr.orgId, engr.userId);
  else if (view === 'technician') rows = await listForTechnician(db, engr.orgId, engr.userId);
  else if (view === 'station') rows = await listForStationManager(db, engr.orgId, engr.userId);
  else rows = await listForEngineer(db, engr.orgId, status);

  return jsonResponse({ ok: true, view, workOrders: rows }, 200);
};
