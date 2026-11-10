export const prerender = false;

import type { APIRoute } from 'astro';
import { getDb } from '@engr/db';
import { getEngrEnv } from '@engr/env';
import { contractorForUser } from '@engr/repos/techniciansPick';
import { actorDataScope } from '@engr/auth/dataScope';

export const GET: APIRoute = async ({ params, locals }) => {
  const engr = locals.engr;
  if (!engr) return new Response('Unauthorised', { status: 401 });
  if (!engr.perms.includes('bill.view')) return new Response('Forbidden', { status: 403 });
  const db = await getDb(getEngrEnv(), locals);
  const contractorId =
    actorDataScope(engr.roles) === 'contractor'
      ? await contractorForUser(db, engr.orgId, engr.userId)
      : null;
  if (actorDataScope(engr.roles) === 'contractor' && !contractorId)
    return new Response('Not found', { status: 404 });
  const result = await db.execute({
    sql: `SELECT original_pdf FROM supplier_invoices
           WHERE id = ? AND org_id = ? AND (? IS NULL OR contractor_id = ?) LIMIT 1`,
    args: [params.id ?? '', engr.orgId, contractorId, contractorId],
  });
  const raw = result.rows[0]?.original_pdf;
  if (!(raw instanceof Uint8Array)) return new Response('Not found', { status: 404 });
  return new Response(Uint8Array.from(raw as Uint8Array).buffer, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="contractor-invoice.pdf"',
      'content-security-policy': 'sandbox',
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
};
