/**
 * Analytics aggregations for the staff dashboard and reports, scoped within the
 * acting tenant. Driven by the seeded customer base (counts by country, type and
 * status, credit utilisation and the top accounts by value) and, now that the
 * transactional modules are seeded, by the sales data (revenue over time, the
 * order funnel, the invoice payment mix and the payment-method mix). Every column
 * comes from the typed layer, so a wrong name fails the build. Reads are wrapped
 * by the page's error boundary.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@cms/schema/columns';

const CU = cols(C.customers);
const O = cols(C.orders);
const I = cols(C.invoices);
const P = cols(C.payment_uploads);

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

export interface SalesSummary {
  totalOrders: number;
  totalRevenue: number;
  totalInvoiced: number;
  totalCollected: number;
}
export interface SalesAnalytics {
  summary: SalesSummary;
  revenueByMonth: ChartDatum[];
  ordersByStatus: ChartDatum[];
  invoicesByPayment: ChartDatum[];
  paymentsByMethod: ChartDatum[];
}

/**
 * The sales analytics for the dashboard: a summary plus the revenue time series
 * and the order/invoice/payment breakdowns, in one round of queries. Cancelled
 * orders are excluded from revenue.
 */
export async function getSalesAnalytics(db: Client): Promise<SalesAnalytics> {
  const [summaryRes, revenue, ordersByStatus, invoicesByPayment, paymentsByMethod] =
    await Promise.all([
      db.execute(
        `SELECT
           (SELECT COUNT(*) FROM orders) AS orders,
           (SELECT COALESCE(SUM(${O.total_amount}), 0) FROM orders WHERE ${O.status} != 'CANCELLED') AS revenue,
           (SELECT COALESCE(SUM(${I.total_amount}), 0) FROM invoices) AS invoiced,
           (SELECT COALESCE(SUM(${I.paid_amount}), 0) FROM invoices) AS collected`,
      ),
      db.execute(
        `SELECT substr(${O.requested_date}, 1, 7) AS label, COALESCE(SUM(${O.total_amount}), 0) AS value
           FROM orders
          WHERE ${O.requested_date} IS NOT NULL AND ${O.status} != 'CANCELLED'
          GROUP BY substr(${O.requested_date}, 1, 7)
          ORDER BY label ASC`,
      ),
      db.execute(
        `SELECT COALESCE(${O.status}, 'Unknown') AS label, COUNT(*) AS n
           FROM orders GROUP BY ${O.status} ORDER BY n DESC`,
      ),
      db.execute(
        `SELECT COALESCE(${I.payment_status}, 'Unknown') AS label, COUNT(*) AS n
           FROM invoices GROUP BY ${I.payment_status} ORDER BY n DESC`,
      ),
      db.execute(
        `SELECT COALESCE(${P.payment_method}, 'Unspecified') AS label, COUNT(*) AS n
           FROM payment_uploads GROUP BY ${P.payment_method} ORDER BY n DESC`,
      ),
    ]);
  const s = summaryRes.rows[0] ?? {};
  return {
    summary: {
      totalOrders: num(s.orders),
      totalRevenue: num(s.revenue),
      totalInvoiced: num(s.invoiced),
      totalCollected: num(s.collected),
    },
    revenueByMonth: revenue.rows.map((r) => ({ label: String(r.label), value: num(r.value) })),
    ordersByStatus: ordersByStatus.rows.map((r) => ({ label: String(r.label), value: num(r.n) })),
    invoicesByPayment: invoicesByPayment.rows.map((r) => ({
      label: String(r.label),
      value: num(r.n),
    })),
    paymentsByMethod: paymentsByMethod.rows.map((r) => ({
      label: String(r.label),
      value: num(r.n),
    })),
  };
}
