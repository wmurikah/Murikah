import type { Client } from '@libsql/client/web';

export interface SupplierInvoice {
  id: string;
  billId: string;
  billNo: string;
  contractorName: string;
  invoiceNo: string;
  issueDate: string;
  dueDate: string;
  amountMinor: number;
  currency: string;
  billStatus: string;
  paidMinor: number;
  hasOriginal: boolean;
  createdAt: string;
}

export async function listSupplierInvoices(
  db: Client,
  orgId: string,
  contractorId: string | null,
): Promise<SupplierInvoice[]> {
  const result = await db.execute({
    sql: `SELECT i.id, i.bill_id, i.invoice_no, i.issue_date, i.due_date,
                 i.amount_minor, i.currency, i.original_pdf IS NOT NULL AS has_original,
                 i.created_at, b.bill_no, b.status AS bill_status, c.name AS contractor_name,
                 COALESCE((SELECT SUM(p.amount_minor) FROM payments p
                   WHERE p.bill_id = b.id AND p.org_id = b.org_id AND p.status <> 'REVERSED'), 0) AS paid_minor
            FROM supplier_invoices i
            JOIN bills b ON b.id = i.bill_id AND b.org_id = i.org_id
            JOIN contractors c ON c.id = i.contractor_id AND c.org_id = i.org_id
           WHERE i.org_id = ? AND (? IS NULL OR i.contractor_id = ?)
        ORDER BY i.created_at DESC LIMIT 200`,
    args: [orgId, contractorId, contractorId],
  });
  return result.rows.map((r) => ({
    id: String(r.id),
    billId: String(r.bill_id),
    billNo: String(r.bill_no),
    contractorName: String(r.contractor_name),
    invoiceNo: String(r.invoice_no),
    issueDate: String(r.issue_date),
    dueDate: String(r.due_date),
    amountMinor: Number(r.amount_minor),
    currency: String(r.currency),
    billStatus: String(r.bill_status),
    paidMinor: Number(r.paid_minor),
    hasOriginal: Number(r.has_original) === 1,
    createdAt: String(r.created_at),
  }));
}

export type InvoiceCreateResult =
  | { ok: true; id: string }
  | { ok: false; code: 'invalid' | 'conflict' | 'not_found'; message: string };

export async function createSupplierInvoice(
  db: Client,
  ctx: { orgId: string; userId: string; contractorId: string },
  input: {
    billId: string;
    invoiceNo: string;
    issueDate: string;
    dueDate: string;
    taxReference: string | null;
    notes: string | null;
    originalName: string;
    originalPdf: Uint8Array;
  },
): Promise<InvoiceCreateResult> {
  const validDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (
    !input.invoiceNo ||
    input.invoiceNo.length > 80 ||
    !validDate(input.issueDate) ||
    !validDate(input.dueDate) ||
    input.dueDate < input.issueDate ||
    (input.taxReference?.length ?? 0) > 100 ||
    (input.notes?.length ?? 0) > 1000 ||
    input.originalPdf.length < 5 ||
    input.originalPdf.length > 2 * 1024 * 1024 ||
    new TextDecoder().decode(input.originalPdf.subarray(0, 5)) !== '%PDF-'
  ) {
    return { ok: false, code: 'invalid', message: 'Enter a valid invoice and a PDF up to 2 MB.' };
  }
  const bill = await db.execute({
    sql: `SELECT total_minor, status FROM bills
           WHERE id = ? AND org_id = ? AND contractor_id = ? LIMIT 1`,
    args: [input.billId, ctx.orgId, ctx.contractorId],
  });
  const row = bill.rows[0];
  if (!row) return { ok: false, code: 'not_found', message: 'Bill not found.' };
  if (String(row.status) !== 'DRAFT')
    return { ok: false, code: 'conflict', message: 'Add the invoice while the bill is a draft.' };
  if (Number(row.total_minor) <= 0)
    return {
      ok: false,
      code: 'invalid',
      message: 'Attach approved costs before adding an invoice.',
    };
  const id = crypto.randomUUID().replace(/-/g, '');
  const tx = await db.transaction('write');
  try {
    const inserted = await tx.execute({
      sql: `INSERT INTO supplier_invoices
        (id, org_id, contractor_id, bill_id, invoice_no, issue_date, due_date,
         amount_minor, currency, tax_reference, notes, original_name, original_pdf, submitted_by)
        SELECT ?, ?, ?, b.id, ?, ?, ?, b.total_minor, b.currency, ?, ?, ?, ?, ?
          FROM bills b WHERE b.id = ? AND b.org_id = ? AND b.contractor_id = ?
            AND b.status = 'DRAFT' AND b.total_minor > 0`,
      args: [
        id,
        ctx.orgId,
        ctx.contractorId,
        input.invoiceNo,
        input.issueDate,
        input.dueDate,
        input.taxReference,
        input.notes,
        input.originalName.slice(0, 150),
        input.originalPdf,
        ctx.userId,
        input.billId,
        ctx.orgId,
        ctx.contractorId,
      ],
    });
    if (inserted.rowsAffected !== 1) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'Bill changed. Reload and try again.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'invoice.create', 'supplier_invoice', ?, ?)`,
      args: [
        ctx.orgId,
        ctx.userId,
        id,
        JSON.stringify({ bill_id: input.billId, invoice_no: input.invoiceNo }),
      ],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (/UNIQUE|CONSTRAINT/.test(String(err)))
      return {
        ok: false,
        code: 'conflict',
        message: 'This bill or invoice number already has an invoice.',
      };
    throw err;
  }
}
