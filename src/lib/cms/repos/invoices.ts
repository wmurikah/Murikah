/**
 * Invoices, ported from the source billing service. An invoice belongs to one
 * order and one customer and carries its own subtotal/tax/total plus the ETIMS
 * fields; its line detail is the parent order's lines (there is no separate
 * invoice-line table). Scoped within the acting tenant; the portal list is
 * additionally scoped to the signed-in customer's own customer_id. Every column
 * comes from the typed layer, so a wrong name fails the build.
 */
import type { Client, InArgs } from '@libsql/client/web';
import { C, cols } from '@cms/schema/columns';
import { type OrderLine } from '@cms/repos/orders';

const I = cols(C.invoices);
const OL = cols(C.order_lines);

export interface InvoiceFilters {
  q?: string;
  status?: string;
  customerId?: string;
}

export interface InvoiceRow {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string | null;
  companyName: string | null;
  status: string | null;
  paymentStatus: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalAmount: number | null;
  currencyCode: string | null;
}

const s = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** Invoices for the tenant (or one customer), newest first, with optional filters. */
export async function listInvoices(
  db: Client,
  filters: InvoiceFilters = {},
): Promise<InvoiceRow[]> {
  const args: InArgs = [];
  const where: string[] = [];
  if (filters.q && filters.q.trim()) {
    where.push(`${I.invoice_number} LIKE ?`);
    args.push(`%${filters.q.trim()}%`);
  }
  if (filters.status) {
    where.push(`${I.status} = ?`);
    args.push(filters.status);
  }
  if (filters.customerId) {
    where.push(`${I.customer_id} = ?`);
    args.push(filters.customerId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const res = await db.execute({
    sql: `SELECT ${I.invoice_id} AS id, ${I.invoice_number} AS invoice_number, ${I.customer_id} AS customer_id,
                 c.company_name AS company_name, ${I.status} AS status, ${I.payment_status} AS payment_status,
                 ${I.issue_date} AS issue_date, ${I.due_date} AS due_date, ${I.total_amount} AS total_amount,
                 ${I.currency_code} AS currency_code
            FROM invoices i
            LEFT JOIN customers c ON c.customer_id = ${I.customer_id}
            ${clause}
        ORDER BY ${I.issue_date} DESC, ${I.invoice_number} DESC
           LIMIT 500`,
    args,
  });
  return res.rows.map((r) => ({
    invoiceId: String(r.id),
    invoiceNumber: String(r.invoice_number ?? r.id),
    customerId: s(r.customer_id),
    companyName: s(r.company_name),
    status: s(r.status),
    paymentStatus: s(r.payment_status),
    issueDate: s(r.issue_date),
    dueDate: s(r.due_date),
    totalAmount: num(r.total_amount),
    currencyCode: s(r.currency_code),
  }));
}

/** Invoices belonging to one customer, for the portal. */
export function listInvoicesForCustomer(db: Client, customerId: string): Promise<InvoiceRow[]> {
  return listInvoices(db, { customerId });
}

export type InvoiceDetail = Record<string, unknown> & {
  invoiceId: string;
  invoiceNumber: string;
  orderId: string | null;
};

/** A single invoice and the lines from its parent order, or null when not found. */
export async function getInvoice(
  db: Client,
  id: string,
): Promise<{ invoice: InvoiceDetail; lines: OrderLine[] } | null> {
  const res = await db.execute({
    sql: `SELECT * FROM invoices WHERE ${I.invoice_id} = ? LIMIT 1`,
    args: [id],
  });
  const row = res.rows[0];
  if (!row) return null;
  const invoice = { ...row } as Record<string, unknown>;
  invoice.invoiceId = String(row.invoice_id);
  invoice.invoiceNumber = String(row.invoice_number ?? row.invoice_id);
  invoice.orderId = row.order_id == null ? null : String(row.order_id);

  let lines: OrderLine[] = [];
  if (invoice.orderId) {
    const lineRes = await db.execute({
      sql: `SELECT ${OL.product_name} AS product_name, ${OL.quantity} AS quantity,
                   ${OL.unit_price} AS unit_price, ${OL.line_total} AS line_total
              FROM order_lines WHERE ${OL.order_id} = ? ORDER BY ${OL.line_id} ASC`,
      args: [invoice.orderId as string],
    });
    lines = lineRes.rows.map((r) => ({
      productName: String(r.product_name ?? '-'),
      quantity: num(r.quantity),
      unitPrice: num(r.unit_price),
      lineTotal: num(r.line_total),
    }));
  }
  return { invoice: invoice as InvoiceDetail, lines };
}
