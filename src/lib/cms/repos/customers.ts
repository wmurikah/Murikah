/**
 * Customers and their contacts, ported from the source customer service. Scoped
 * within the acting (Hass) tenant; staff visibility further follows the source's
 * country and role scoping as those land. Every column comes from the typed
 * layer, so a wrong name fails the build. Reads only in this first increment; the
 * create and edit round-trip follows in the same phase.
 */
import type { Client, InArgs } from '@libsql/client/web';
import { C, cols } from '@cms/schema/columns';

const CU = cols(C.customers);
const CT = cols(C.contacts);

export interface CustomerFilters {
  q?: string;
  status?: string;
  countryCode?: string;
  customerType?: string;
}

export interface CustomerRow {
  customerId: string;
  accountNumber: string | null;
  companyName: string;
  customerType: string | null;
  countryCode: string | null;
  status: string | null;
  creditLimit: number | null;
  creditUsed: number | null;
  lifetimeValue: number | null;
}

const s = (v: unknown): string | null => (v == null ? null : String(v));
const n = (v: unknown): number | null => (v == null ? null : Number(v));

/** Customers for the tenant, newest activity first, with optional filters. */
export async function listCustomers(
  db: Client,
  filters: CustomerFilters = {},
): Promise<CustomerRow[]> {
  const args: InArgs = [];
  const where: string[] = [];
  if (filters.q && filters.q.trim()) {
    where.push(`(${CU.company_name} LIKE ? OR ${CU.account_number} LIKE ? OR ${CU.email} LIKE ?)`);
    const like = `%${filters.q.trim()}%`;
    args.push(like, like, like);
  }
  if (filters.status) {
    where.push(`${CU.status} = ?`);
    args.push(filters.status);
  }
  if (filters.countryCode) {
    where.push(`${CU.country_code} = ?`);
    args.push(filters.countryCode);
  }
  if (filters.customerType) {
    where.push(`${CU.customer_type} = ?`);
    args.push(filters.customerType);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const res = await db.execute({
    sql: `SELECT ${CU.customer_id} AS id, ${CU.account_number} AS account_number,
                 ${CU.company_name} AS company_name, ${CU.customer_type} AS customer_type,
                 ${CU.country_code} AS country_code, ${CU.status} AS status,
                 ${CU.credit_limit} AS credit_limit, ${CU.credit_used} AS credit_used,
                 ${CU.lifetime_value} AS lifetime_value
            FROM customers ${clause}
        ORDER BY ${CU.company_name} ASC
           LIMIT 500`,
    args,
  });
  return res.rows.map((r) => ({
    customerId: String(r.id),
    accountNumber: s(r.account_number),
    companyName: String(r.company_name ?? r.id),
    customerType: s(r.customer_type),
    countryCode: s(r.country_code),
    status: s(r.status),
    creditLimit: n(r.credit_limit),
    creditUsed: n(r.credit_used),
    lifetimeValue: n(r.lifetime_value),
  }));
}

export type CustomerDetail = Record<string, unknown> & {
  customerId: string;
  companyName: string;
};

/** A single customer, or null when not found in the tenant. */
export async function getCustomer(db: Client, id: string): Promise<CustomerDetail | null> {
  const res = await db.execute({
    sql: `SELECT * FROM customers WHERE ${CU.customer_id} = ? LIMIT 1`,
    args: [id],
  });
  const row = res.rows[0];
  if (!row) return null;
  const detail = { ...row } as Record<string, unknown>;
  detail.customerId = String(row.customer_id);
  detail.companyName = String(row.company_name ?? row.customer_id);
  return detail as CustomerDetail;
}

export interface ContactRow {
  contactId: string;
  name: string;
  email: string | null;
  phone: string | null;
  jobTitle: string | null;
  isPortalUser: boolean;
  status: string | null;
}

/** The contacts belonging to a customer. */
export async function listContactsForCustomer(
  db: Client,
  customerId: string,
): Promise<ContactRow[]> {
  const res = await db.execute({
    sql: `SELECT ${CT.contact_id} AS id, ${CT.first_name} AS first_name, ${CT.last_name} AS last_name,
                 ${CT.email} AS email, ${CT.phone} AS phone, ${CT.job_title} AS job_title,
                 ${CT.is_portal_user} AS is_portal_user, ${CT.status} AS status
            FROM contacts WHERE ${CT.customer_id} = ?
        ORDER BY ${CT.first_name} ASC, ${CT.last_name} ASC`,
    args: [customerId],
  });
  return res.rows.map((r) => ({
    contactId: String(r.id),
    name: [s(r.first_name), s(r.last_name)].filter(Boolean).join(' ') || String(r.email ?? r.id),
    email: s(r.email),
    phone: s(r.phone),
    jobTitle: s(r.job_title),
    isPortalUser: Number(r.is_portal_user ?? 0) === 1,
    status: s(r.status),
  }));
}
