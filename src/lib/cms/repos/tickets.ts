/**
 * Support tickets and their comment thread, ported from the source ticketing
 * service. Scoped within the acting tenant; the portal list is additionally
 * scoped to the signed-in customer's own customer_id and never shows internal
 * comments. Every column comes from the typed layer, so a wrong name fails the
 * build.
 */
import type { Client, InArgs } from '@libsql/client/web';
import { C, cols } from '@cms/schema/columns';

const T = cols(C.tickets);
const TC = cols(C.ticket_comments);

export interface TicketFilters {
  q?: string;
  status?: string;
  priority?: string;
  customerId?: string;
}

export interface TicketRow {
  ticketId: string;
  ticketNumber: string;
  customerId: string | null;
  companyName: string | null;
  subject: string;
  category: string | null;
  priority: string | null;
  status: string | null;
  createdAt: string | null;
}

export interface TicketComment {
  authorName: string | null;
  content: string;
  isInternal: boolean;
  isResolution: boolean;
  createdAt: string | null;
}

const s = (v: unknown): string | null => (v == null ? null : String(v));

/** Tickets for the tenant (or one customer), newest first, with optional filters. */
export async function listTickets(db: Client, filters: TicketFilters = {}): Promise<TicketRow[]> {
  const args: InArgs = [];
  const where: string[] = [];
  if (filters.q && filters.q.trim()) {
    where.push(`(${T.ticket_number} LIKE ? OR ${T.subject} LIKE ?)`);
    args.push(`%${filters.q.trim()}%`, `%${filters.q.trim()}%`);
  }
  if (filters.status) {
    where.push(`${T.status} = ?`);
    args.push(filters.status);
  }
  if (filters.priority) {
    where.push(`${T.priority} = ?`);
    args.push(filters.priority);
  }
  if (filters.customerId) {
    where.push(`${T.customer_id} = ?`);
    args.push(filters.customerId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const res = await db.execute({
    sql: `SELECT ${T.ticket_id} AS id, ${T.ticket_number} AS ticket_number, ${T.customer_id} AS customer_id,
                 c.company_name AS company_name, ${T.subject} AS subject, ${T.category} AS category,
                 ${T.priority} AS priority, ${T.status} AS status, ${T.created_at} AS created_at
            FROM tickets t
            LEFT JOIN customers c ON c.customer_id = ${T.customer_id}
            ${clause}
        ORDER BY ${T.created_at} DESC, ${T.ticket_number} DESC
           LIMIT 500`,
    args,
  });
  return res.rows.map((r) => ({
    ticketId: String(r.id),
    ticketNumber: String(r.ticket_number ?? r.id),
    customerId: s(r.customer_id),
    companyName: s(r.company_name),
    subject: String(r.subject ?? '-'),
    category: s(r.category),
    priority: s(r.priority),
    status: s(r.status),
    createdAt: s(r.created_at),
  }));
}

/** Tickets belonging to one customer, for the portal. */
export function listTicketsForCustomer(db: Client, customerId: string): Promise<TicketRow[]> {
  return listTickets(db, { customerId });
}

export type TicketDetail = Record<string, unknown> & { ticketId: string; ticketNumber: string };

/**
 * A single ticket and its comment thread, or null when not found. Pass
 * includeInternal=false (the portal) to exclude internal staff comments.
 */
export async function getTicket(
  db: Client,
  id: string,
  includeInternal = true,
): Promise<{ ticket: TicketDetail; comments: TicketComment[] } | null> {
  const res = await db.execute({
    sql: `SELECT * FROM tickets WHERE ${T.ticket_id} = ? LIMIT 1`,
    args: [id],
  });
  const row = res.rows[0];
  if (!row) return null;
  const ticket = { ...row } as Record<string, unknown>;
  ticket.ticketId = String(row.ticket_id);
  ticket.ticketNumber = String(row.ticket_number ?? row.ticket_id);

  const internalClause = includeInternal ? '' : `AND ${TC.is_internal} = 0`;
  const commentRes = await db.execute({
    sql: `SELECT ${TC.author_name} AS author_name, ${TC.content} AS content,
                 ${TC.is_internal} AS is_internal, ${TC.is_resolution} AS is_resolution,
                 ${TC.created_at} AS created_at
            FROM ticket_comments
           WHERE ${TC.ticket_id} = ? ${internalClause}
        ORDER BY ${TC.created_at} ASC`,
    args: [id],
  });
  const comments: TicketComment[] = commentRes.rows.map((r) => ({
    authorName: s(r.author_name),
    content: String(r.content ?? ''),
    isInternal: Number(r.is_internal) === 1,
    isResolution: Number(r.is_resolution) === 1,
    createdAt: s(r.created_at),
  }));
  return { ticket: ticket as TicketDetail, comments };
}
