/**
 * Payment uploads, ported from the source payments service: proof-of-payment
 * receipts (M-Pesa, bank transfer, Oracle) that customers submit and staff
 * review and match to an invoice. Scoped within the acting tenant; the portal
 * list is additionally scoped to the signed-in customer's own customer_id. Every
 * column comes from the typed layer, so a wrong name fails the build.
 */
import type { Client, InArgs } from '@libsql/client/web';
import { C, cols } from '@cms/schema/columns';

const P = cols(C.payment_uploads);

export interface PaymentFilters {
  q?: string;
  status?: string;
  customerId?: string;
}

export interface PaymentRow {
  uploadId: string;
  customerId: string | null;
  companyName: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  paymentMethod: string | null;
  amount: number | null;
  currencyCode: string | null;
  referenceNumber: string | null;
  uploadDate: string | null;
  status: string | null;
}

const s = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** Payment uploads for the tenant (or one customer), newest first, with filters. */
export async function listPayments(
  db: Client,
  filters: PaymentFilters = {},
): Promise<PaymentRow[]> {
  const args: InArgs = [];
  const where: string[] = [];
  if (filters.q && filters.q.trim()) {
    where.push(`${P.reference_number} LIKE ?`);
    args.push(`%${filters.q.trim()}%`);
  }
  if (filters.status) {
    where.push(`${P.status} = ?`);
    args.push(filters.status);
  }
  if (filters.customerId) {
    where.push(`${P.customer_id} = ?`);
    args.push(filters.customerId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const res = await db.execute({
    sql: `SELECT ${P.upload_id} AS id, ${P.customer_id} AS customer_id, c.company_name AS company_name,
                 ${P.invoice_id} AS invoice_id, iv.invoice_number AS invoice_number,
                 ${P.payment_method} AS payment_method, ${P.amount} AS amount,
                 ${P.currency_code} AS currency_code, ${P.reference_number} AS reference_number,
                 ${P.upload_date} AS upload_date, ${P.status} AS status
            FROM payment_uploads p
            LEFT JOIN customers c ON c.customer_id = ${P.customer_id}
            LEFT JOIN invoices iv ON iv.invoice_id = ${P.invoice_id}
            ${clause}
        ORDER BY ${P.upload_date} DESC, ${P.upload_id} DESC
           LIMIT 500`,
    args,
  });
  return res.rows.map((r) => ({
    uploadId: String(r.id),
    customerId: s(r.customer_id),
    companyName: s(r.company_name),
    invoiceId: s(r.invoice_id),
    invoiceNumber: s(r.invoice_number),
    paymentMethod: s(r.payment_method),
    amount: num(r.amount),
    currencyCode: s(r.currency_code),
    referenceNumber: s(r.reference_number),
    uploadDate: s(r.upload_date),
    status: s(r.status),
  }));
}

/** Payment uploads belonging to one customer, for the portal. */
export function listPaymentsForCustomer(db: Client, customerId: string): Promise<PaymentRow[]> {
  return listPayments(db, { customerId });
}

export type PaymentDetail = Record<string, unknown> & { uploadId: string };

/** A single payment upload, with its matched invoice number, or null. */
export async function getPayment(
  db: Client,
  id: string,
): Promise<{ payment: PaymentDetail; invoiceNumber: string | null } | null> {
  const res = await db.execute({
    sql: `SELECT p.*, iv.invoice_number AS matched_invoice_number
            FROM payment_uploads p
            LEFT JOIN invoices iv ON iv.invoice_id = ${P.invoice_id}
           WHERE ${P.upload_id} = ? LIMIT 1`,
    args: [id],
  });
  const row = res.rows[0];
  if (!row) return null;
  const payment = { ...row } as Record<string, unknown>;
  payment.uploadId = String(row.upload_id);
  return { payment: payment as PaymentDetail, invoiceNumber: s(row.matched_invoice_number) };
}
