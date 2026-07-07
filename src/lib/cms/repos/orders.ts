/**
 * Orders and their lines, ported from the source order service. Scoped within the
 * acting tenant; the portal list is additionally scoped to the signed-in
 * customer's own customer_id. Every column comes from the typed layer, so a wrong
 * name fails the build.
 */
import type { Client, InArgs } from '@libsql/client/web';
import { C, cols } from '@cms/schema/columns';

const O = cols(C.orders);
const OL = cols(C.order_lines);

export interface OrderFilters {
  q?: string;
  status?: string;
  customerId?: string;
}

export interface OrderRow {
  orderId: string;
  orderNumber: string;
  customerId: string | null;
  companyName: string | null;
  status: string | null;
  paymentStatus: string | null;
  requestedDate: string | null;
  totalAmount: number | null;
  currencyCode: string | null;
}

const s = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** Orders for the tenant (or one customer), newest first, with optional filters. */
export async function listOrders(db: Client, filters: OrderFilters = {}): Promise<OrderRow[]> {
  const args: InArgs = [];
  const where: string[] = [];
  if (filters.q && filters.q.trim()) {
    where.push(`${O.order_number} LIKE ?`);
    args.push(`%${filters.q.trim()}%`);
  }
  if (filters.status) {
    where.push(`${O.status} = ?`);
    args.push(filters.status);
  }
  if (filters.customerId) {
    where.push(`${O.customer_id} = ?`);
    args.push(filters.customerId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const res = await db.execute({
    sql: `SELECT ${O.order_id} AS id, ${O.order_number} AS order_number, ${O.customer_id} AS customer_id,
                 c.company_name AS company_name, ${O.status} AS status, ${O.payment_status} AS payment_status,
                 ${O.requested_date} AS requested_date, ${O.total_amount} AS total_amount,
                 ${O.currency_code} AS currency_code
            FROM orders o
            LEFT JOIN customers c ON c.customer_id = ${O.customer_id}
            ${clause}
        ORDER BY ${O.requested_date} DESC, ${O.order_number} DESC
           LIMIT 500`,
    args,
  });
  return res.rows.map((r) => ({
    orderId: String(r.id),
    orderNumber: String(r.order_number ?? r.id),
    customerId: s(r.customer_id),
    companyName: s(r.company_name),
    status: s(r.status),
    paymentStatus: s(r.payment_status),
    requestedDate: s(r.requested_date),
    totalAmount: num(r.total_amount),
    currencyCode: s(r.currency_code),
  }));
}

/** Orders belonging to one customer, for the portal. */
export function listOrdersForCustomer(db: Client, customerId: string): Promise<OrderRow[]> {
  return listOrders(db, { customerId });
}

export type OrderDetail = Record<string, unknown> & { orderId: string; orderNumber: string };
export interface OrderLine {
  productName: string;
  quantity: number | null;
  unitPrice: number | null;
  lineTotal: number | null;
}

/** A single order and its lines, or null when not found. */
export async function getOrder(
  db: Client,
  id: string,
): Promise<{ order: OrderDetail; lines: OrderLine[] } | null> {
  const res = await db.execute({
    sql: `SELECT * FROM orders WHERE ${O.order_id} = ? LIMIT 1`,
    args: [id],
  });
  const row = res.rows[0];
  if (!row) return null;
  const order = { ...row } as Record<string, unknown>;
  order.orderId = String(row.order_id);
  order.orderNumber = String(row.order_number ?? row.order_id);

  const lineRes = await db.execute({
    sql: `SELECT ${OL.product_name} AS product_name, ${OL.quantity} AS quantity,
                 ${OL.unit_price} AS unit_price, ${OL.line_total} AS line_total
            FROM order_lines WHERE ${OL.order_id} = ? ORDER BY ${OL.line_id} ASC`,
    args: [id],
  });
  const lines: OrderLine[] = lineRes.rows.map((r) => ({
    productName: String(r.product_name ?? '-'),
    quantity: num(r.quantity),
    unitPrice: num(r.unit_price),
    lineTotal: num(r.line_total),
  }));
  return { order: order as OrderDetail, lines };
}
