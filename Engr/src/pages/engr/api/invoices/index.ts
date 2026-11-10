export const prerender = false;

import type { APIRoute } from 'astro';
import { getDb } from '@engr/db';
import { getEngrEnv } from '@engr/env';
import { contractorForUser } from '@engr/repos/techniciansPick';
import { createSupplierInvoice, listSupplierInvoices } from '@engr/repos/supplierInvoices';
import { actorDataScope } from '@engr/auth/dataScope';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function boundedForm(request: Request): Promise<FormData | 'file_too_large' | 'invalid'> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data;') || !request.body) return 'invalid';
  if (Number(request.headers.get('content-length') ?? '0') > 3 * 1024 * 1024)
    return 'file_too_large';
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 3 * 1024 * 1024) {
        await reader.cancel();
        return 'file_too_large';
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return await new Response(bytes.buffer, {
      headers: { 'content-type': contentType },
    }).formData();
  } catch {
    return 'invalid';
  }
}

export const GET: APIRoute = async ({ locals }) => {
  const engr = locals.engr;
  if (!engr) return json({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('bill.view')) return json({ error: 'forbidden' }, 403);
  const db = await getDb(getEngrEnv(), locals);
  const contractorId =
    actorDataScope(engr.roles) === 'contractor'
      ? await contractorForUser(db, engr.orgId, engr.userId)
      : null;
  if (actorDataScope(engr.roles) === 'contractor' && !contractorId)
    return json({ invoices: [] }, 200);
  return json({ invoices: await listSupplierInvoices(db, engr.orgId, contractorId) }, 200);
};

export const POST: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return json({ error: 'unauthorised' }, 401);
  if (!engr.perms.includes('bill.create')) return json({ error: 'forbidden' }, 403);
  const db = await getDb(getEngrEnv(), locals);
  const contractorId = await contractorForUser(db, engr.orgId, engr.userId);
  if (!contractorId) return json({ error: 'forbidden' }, 403);
  const billId = new URL(request.url).searchParams.get('bill') ?? '';
  if (!/^[a-f0-9]{32}$/.test(billId)) return json({ error: 'invalid_bill' }, 400);
  const formError = (code: string, status: number) =>
    request.headers.get('accept')?.includes('application/json')
      ? json({ error: code }, status)
      : new Response(null, {
          status: 303,
          headers: { location: `/bills/${billId}?invoice_error=${code}` },
        });
  const form = await boundedForm(request);
  if (typeof form === 'string') return formError(form, form === 'file_too_large' ? 413 : 422);
  const file = form.get('original_pdf');
  if (!(file instanceof File) || file.size > 2 * 1024 * 1024 || file.size < 5)
    return formError(
      file instanceof File && file.size > 2 * 1024 * 1024 ? 'file_too_large' : 'invalid_pdf',
      422,
    );
  if (String(form.get('bill_id') ?? '') !== billId) return formError('invalid_bill', 422);
  const result = await createSupplierInvoice(
    db,
    {
      orgId: engr.orgId,
      userId: engr.userId,
      contractorId,
    },
    {
      billId,
      invoiceNo: String(form.get('invoice_no') ?? '').trim(),
      issueDate: String(form.get('issue_date') ?? ''),
      dueDate: String(form.get('due_date') ?? ''),
      taxReference: String(form.get('tax_reference') ?? '').trim() || null,
      notes: String(form.get('notes') ?? '').trim() || null,
      originalName: file.name,
      originalPdf: new Uint8Array(await file.arrayBuffer()),
    },
  );
  if (request.headers.get('accept')?.includes('application/json'))
    return json(result, result.ok ? 201 : result.code === 'conflict' ? 409 : 422);
  const dest = result.ok
    ? `/bills/${billId}?invoice=1`
    : `/bills/${billId}?invoice_error=${result.code}`;
  return new Response(null, { status: 303, headers: { location: dest } });
};
