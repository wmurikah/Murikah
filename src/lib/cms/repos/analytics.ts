/**
 * Analytics aggregations for the staff dashboard and reports, scoped within the
 * acting tenant. This first phase is driven by the seeded customer base (counts
 * by country, type and status, credit utilisation and the top accounts by
 * value); order, invoice, payment and ticket time series follow as those modules
 * are seeded. Every column comes from the typed layer, so a wrong name fails the
 * build. Reads are wrapped by the page's error boundary.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@cms/schema/columns';

const CU = cols(C.customers);

export interface ChartDatum {
  label: string;
  value: number;
}
export interface AnalyticsSummary {
  totalCustomers: number;
  totalCreditLimit: number;
  totalCreditUsed: number;
  totalLifetimeValue: number;
}
export interface CustomerAnalytics {
  summary: AnalyticsSummary;
  byCountry: ChartDatum[];
  byType: ChartDatum[];
  byStatus: ChartDatum[];
  topByValue: ChartDatum[];
}

const num = (v: unknown): number => Number(v ?? 0);

async function groupCount(db: Client, column: string, fallback: string): Promise<ChartDatum[]> {
  const res = await db.execute(
    `SELECT COALESCE(${column}, '${fallback}') AS label, COUNT(*) AS n
       FROM customers GROUP BY ${column} ORDER BY n DESC`,
  );
  return res.rows.map((r) => ({ label: String(r.label), value: num(r.n) }));
}

/** The customer analytics for the dashboard, in one round of queries. */
export async function getCustomerAnalytics(db: Client): Promise<CustomerAnalytics> {
  const [summaryRes, byCountry, byType, byStatus, topRes] = await Promise.all([
    db.execute(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(${CU.credit_limit}), 0) AS credit_limit,
              COALESCE(SUM(${CU.credit_used}), 0) AS credit_used,
              COALESCE(SUM(${CU.lifetime_value}), 0) AS ltv
         FROM customers`,
    ),
    groupCount(db, CU.country_code, 'Unknown'),
    groupCount(db, CU.customer_type, 'Unspecified'),
    groupCount(db, CU.status, 'Unknown'),
    db.execute(
      `SELECT ${CU.company_name} AS label, ${CU.lifetime_value} AS value
         FROM customers WHERE ${CU.lifetime_value} IS NOT NULL
     ORDER BY ${CU.lifetime_value} DESC LIMIT 8`,
    ),
  ]);
  const s = summaryRes.rows[0] ?? {};
  return {
    summary: {
      totalCustomers: num(s.total),
      totalCreditLimit: num(s.credit_limit),
      totalCreditUsed: num(s.credit_used),
      totalLifetimeValue: num(s.ltv),
    },
    byCountry,
    byType,
    byStatus,
    topByValue: topRes.rows.map((r) => ({ label: String(r.label), value: num(r.value) })),
  };
}
