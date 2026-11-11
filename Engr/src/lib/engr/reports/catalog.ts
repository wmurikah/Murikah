import type { Client } from '@libsql/client/web';

export interface ReportDefinition {
  id: string;
  title: string;
  category: string;
  description: string;
  permission: string;
  columns: readonly { key: string; label: string; money?: boolean }[];
  sql: string;
  dateExpression: string;
}

/** Every query has an organisation predicate. The caller must also pass the
 * source permission in addition to reports.view/reports.export. */
export const REPORTS: readonly ReportDefinition[] = [
  {
    id: 'requests',
    title: 'Service requests',
    category: 'Operations',
    description: 'Request volume, priority and resolution by location.',
    permission: 'requests.view',
    columns: [
      { key: 'request_no', label: 'Request' },
      { key: 'station', label: 'Location' },
      { key: 'priority', label: 'Priority' },
      { key: 'status', label: 'Status' },
      { key: 'created_at', label: 'Raised' },
      { key: 'closed_at', label: 'Closed' },
    ],
    sql: `SELECT r.request_no, s.name AS station, r.priority, r.status, r.created_at, r.closed_at
            FROM service_requests r JOIN stations s ON s.id = r.station_id AND s.org_id = r.org_id
           WHERE r.org_id = ? AND r.deleted_at IS NULL`,
    dateExpression: 'r.created_at',
  },
  {
    id: 'work_orders',
    title: 'Work orders',
    category: 'Operations',
    description: 'Work by status, source, location and contractor.',
    permission: 'workorder.view',
    columns: [
      { key: 'wo_no', label: 'Work order' },
      { key: 'station', label: 'Location' },
      { key: 'contractor', label: 'Contractor' },
      { key: 'source', label: 'Source' },
      { key: 'status', label: 'Status' },
      { key: 'created_at', label: 'Created' },
      { key: 'closed_at', label: 'Closed' },
    ],
    sql: `SELECT w.wo_no, s.name AS station, c.name AS contractor, w.source, w.status,
                 w.created_at, w.closed_at FROM work_orders w
            JOIN stations s ON s.id = w.station_id AND s.org_id = w.org_id
       LEFT JOIN contractors c ON c.id = w.contractor_id AND c.org_id = w.org_id
           WHERE w.org_id = ? AND w.deleted_at IS NULL`,
    dateExpression: 'w.created_at',
  },
  {
    id: 'rfqs',
    title: 'RFQs',
    category: 'Procurement',
    description: 'RFQ progress and response deadlines.',
    permission: 'rfq.view',
    columns: [
      { key: 'rfq_no', label: 'RFQ' },
      { key: 'request_no', label: 'Request' },
      { key: 'status', label: 'Status' },
      { key: 'due_date', label: 'Due' },
      { key: 'created_at', label: 'Created' },
    ],
    sql: `SELECT q.rfq_no, r.request_no, q.status, q.due_date, q.created_at FROM rfqs q
            JOIN service_requests r ON r.id = q.request_id AND r.org_id = q.org_id
           WHERE q.org_id = ?`,
    dateExpression: 'q.created_at',
  },
  {
    id: 'lpos',
    title: 'LPO commitments',
    category: 'Procurement',
    description: 'Purchase orders and committed amounts.',
    permission: 'lpo.view',
    columns: [
      { key: 'lpo_no', label: 'LPO' },
      { key: 'contractor', label: 'Contractor' },
      { key: 'status', label: 'Status' },
      { key: 'total_minor', label: 'Total', money: true },
      { key: 'currency', label: 'Currency' },
      { key: 'created_at', label: 'Created' },
    ],
    sql: `SELECT l.lpo_no, c.name AS contractor, l.status, l.total_minor, l.currency, l.created_at
            FROM lpos l JOIN contractors c ON c.id = l.contractor_id AND c.org_id = l.org_id
           WHERE l.org_id = ?`,
    dateExpression: 'l.created_at',
  },
  {
    id: 'maintenance',
    title: 'Preventive maintenance',
    category: 'Maintenance & assets',
    description: 'Scheduled, completed and overdue maintenance occurrences.',
    permission: 'pm.view',
    columns: [
      { key: 'schedule', label: 'Schedule' },
      { key: 'station', label: 'Location' },
      { key: 'due_date', label: 'Due' },
      { key: 'status', label: 'Status' },
    ],
    sql: `SELECT p.name AS schedule, s.name AS station, o.due_date, o.status
            FROM pm_occurrences o JOIN pm_schedules p ON p.id = o.pm_schedule_id AND p.org_id = o.org_id
       LEFT JOIN stations s ON s.id = p.station_id AND s.org_id = p.org_id
           WHERE o.org_id = ?`,
    dateExpression: 'o.due_date',
  },
  {
    id: 'assets',
    title: 'Asset register',
    category: 'Maintenance & assets',
    description: 'Current asset location, region and condition.',
    permission: 'assets.view',
    columns: [
      { key: 'tag', label: 'Asset tag' },
      { key: 'asset_name', label: 'Asset' },
      { key: 'station', label: 'Location' },
      { key: 'region', label: 'Region' },
      { key: 'status', label: 'Status' },
      { key: 'created_at', label: 'Added' },
    ],
    sql: `SELECT a.tag, a.name AS asset_name, s.name AS station, r.name AS region,
                 a.status, a.created_at FROM assets a
            JOIN stations s ON s.id = a.station_id AND s.org_id = a.org_id
       LEFT JOIN regions r ON r.id = s.region_id AND r.org_id = a.org_id
           WHERE a.org_id = ? AND a.deleted_at IS NULL`,
    dateExpression: 'a.created_at',
  },
  {
    id: 'asset_movements',
    title: 'Asset movements',
    category: 'Maintenance & assets',
    description: 'Every recorded transfer between locations and regions.',
    permission: 'assets.view',
    columns: [
      { key: 'tag', label: 'Asset tag' },
      { key: 'from_station_name', label: 'From location' },
      { key: 'from_region_name', label: 'From region' },
      { key: 'to_station_name', label: 'To location' },
      { key: 'to_region_name', label: 'To region' },
      { key: 'reason', label: 'Reason' },
      { key: 'moved_by', label: 'Moved by' },
      { key: 'moved_at', label: 'Moved at' },
    ],
    sql: `SELECT a.tag, m.from_station_name, m.from_region_name, m.to_station_name,
                 m.to_region_name, m.reason, u.full_name AS moved_by, m.moved_at
            FROM asset_movements m JOIN assets a ON a.id = m.asset_id AND a.org_id = m.org_id
       LEFT JOIN users u ON u.id = m.moved_by AND u.org_id = m.org_id
           WHERE m.org_id = ?`,
    dateExpression: 'm.moved_at',
  },
  {
    id: 'costs',
    title: 'Work costs',
    category: 'Finance',
    description: 'Submitted and approved work costs by contractor.',
    permission: 'cost.view',
    columns: [
      { key: 'wo_no', label: 'Work order' },
      { key: 'contractor', label: 'Contractor' },
      { key: 'status', label: 'Status' },
      { key: 'total_minor', label: 'Total', money: true },
      { key: 'currency', label: 'Currency' },
      { key: 'created_at', label: 'Created' },
    ],
    sql: `SELECT w.wo_no, c.name AS contractor, x.status, x.total_minor, x.currency, x.created_at
            FROM work_costs x JOIN work_orders w ON w.id = x.work_order_id AND w.org_id = x.org_id
            JOIN contractors c ON c.id = x.contractor_id AND c.org_id = x.org_id
           WHERE x.org_id = ?`,
    dateExpression: 'x.created_at',
  },
  {
    id: 'bills',
    title: 'Bill approvals',
    category: 'Finance',
    description: 'Contractor bills, tax and approval state.',
    permission: 'bill.view',
    columns: [
      { key: 'bill_no', label: 'Bill' },
      { key: 'contractor', label: 'Contractor' },
      { key: 'status', label: 'Status' },
      { key: 'subtotal_minor', label: 'Subtotal', money: true },
      { key: 'tax_minor', label: 'Tax', money: true },
      { key: 'total_minor', label: 'Total', money: true },
      { key: 'currency', label: 'Currency' },
      { key: 'created_at', label: 'Created' },
    ],
    sql: `SELECT b.bill_no, c.name AS contractor, b.status, b.subtotal_minor, b.tax_minor,
                 b.total_minor, b.currency, b.created_at FROM bills b
            JOIN contractors c ON c.id = b.contractor_id AND c.org_id = b.org_id
           WHERE b.org_id = ?`,
    dateExpression: 'b.created_at',
  },
  {
    id: 'invoices',
    title: 'Contractor invoices',
    category: 'Finance',
    description: 'Invoice register, due dates and outstanding balances.',
    permission: 'bill.view',
    columns: [
      { key: 'invoice_no', label: 'Invoice' },
      { key: 'contractor', label: 'Contractor' },
      { key: 'bill_no', label: 'Bill' },
      { key: 'issue_date', label: 'Issued' },
      { key: 'due_date', label: 'Due' },
      { key: 'amount_minor', label: 'Amount', money: true },
      { key: 'outstanding_minor', label: 'Outstanding', money: true },
      { key: 'currency', label: 'Currency' },
    ],
    sql: `SELECT i.invoice_no, c.name AS contractor, b.bill_no, i.issue_date, i.due_date,
                 i.amount_minor, MAX(0, i.amount_minor - COALESCE((SELECT SUM(p.amount_minor)
                   FROM payments p WHERE p.org_id = i.org_id AND p.bill_id = i.bill_id
                     AND p.status <> 'REVERSED'), 0)) AS outstanding_minor, i.currency
            FROM supplier_invoices i JOIN bills b ON b.id = i.bill_id AND b.org_id = i.org_id
            JOIN contractors c ON c.id = i.contractor_id AND c.org_id = i.org_id
           WHERE i.org_id = ?`,
    dateExpression: 'i.issue_date',
  },
  {
    id: 'payments',
    title: 'Payments',
    category: 'Finance',
    description: 'Recorded, reconciled and reversed payments.',
    permission: 'payment.view',
    columns: [
      { key: 'bill_no', label: 'Bill' },
      { key: 'contractor', label: 'Contractor' },
      { key: 'amount_minor', label: 'Amount', money: true },
      { key: 'currency', label: 'Currency' },
      { key: 'method', label: 'Method' },
      { key: 'reference', label: 'Reference' },
      { key: 'status', label: 'Status' },
      { key: 'paid_at', label: 'Paid at' },
    ],
    sql: `SELECT b.bill_no, c.name AS contractor, p.amount_minor, p.currency, p.method,
                 p.reference, p.status, p.paid_at FROM payments p
            JOIN bills b ON b.id = p.bill_id AND b.org_id = p.org_id
            JOIN contractors c ON c.id = b.contractor_id AND c.org_id = p.org_id
           WHERE p.org_id = ?`,
    dateExpression: 'p.created_at',
  },
  {
    id: 'quotes',
    title: 'Contractor quotes',
    category: 'Procurement',
    description: 'Quote submissions and amounts against each RFQ.',
    permission: 'quotes.view',
    columns: [
      { key: 'rfq_no', label: 'RFQ' },
      { key: 'quote_no', label: 'Quote' },
      { key: 'contractor', label: 'Contractor' },
      { key: 'status', label: 'Status' },
      { key: 'total_minor', label: 'Amount', money: true },
      { key: 'currency', label: 'Currency' },
      { key: 'submitted_at', label: 'Submitted' },
    ],
    sql: `SELECT q.rfq_no, x.quote_no, c.name AS contractor, x.status, x.total_minor,
                 x.currency, x.submitted_at FROM quotes x
            JOIN rfqs q ON q.id = x.rfq_id AND q.org_id = x.org_id
            JOIN contractors c ON c.id = x.contractor_id AND c.org_id = x.org_id
           WHERE x.org_id = ?`,
    dateExpression: 'x.created_at',
  },
  {
    id: 'job_cards',
    title: 'Job cards',
    category: 'Operations',
    description: 'Field work and diagnosis recorded against work orders.',
    permission: 'jobcard.view',
    columns: [
      { key: 'wo_no', label: 'Work order' },
      { key: 'technician', label: 'Technician' },
      { key: 'status', label: 'Status' },
      { key: 'diagnosis', label: 'Diagnosis' },
      { key: 'created_at', label: 'Created' },
    ],
    sql: `SELECT w.wo_no, t.full_name AS technician, j.status, j.diagnosis, j.created_at
            FROM job_cards j JOIN work_orders w ON w.id = j.work_order_id AND w.org_id = j.org_id
       LEFT JOIN technicians t ON t.id = j.technician_id AND t.org_id = j.org_id
           WHERE j.org_id = ?`,
    dateExpression: 'j.created_at',
  },
  {
    id: 'bill_approvals',
    title: 'Bill approval trail',
    category: 'Governance',
    description: 'Decision history for contractor bills.',
    permission: 'bill.view',
    columns: [
      { key: 'bill_no', label: 'Bill' },
      { key: 'level', label: 'Level' },
      { key: 'approver', label: 'Approver' },
      { key: 'decision', label: 'Decision' },
      { key: 'comment', label: 'Comment' },
      { key: 'decided_at', label: 'Decided' },
    ],
    sql: `SELECT b.bill_no, a.level, u.full_name AS approver, a.decision,
                 a.comment, a.decided_at FROM bill_approvals a
            JOIN bills b ON b.id = a.bill_id AND b.org_id = a.org_id
       LEFT JOIN users u ON u.id = a.approver_id AND u.org_id = a.org_id
           WHERE a.org_id = ?`,
    dateExpression: 'a.created_at',
  },
  {
    id: 'notification_delivery',
    title: 'Notification delivery',
    category: 'Governance',
    description: 'Queued, held, sent and failed organisation notifications.',
    permission: 'notifications.monitor',
    columns: [
      { key: 'channel', label: 'Channel' },
      { key: 'template_key', label: 'Template' },
      { key: 'status', label: 'Status' },
      { key: 'error', label: 'Delivery note' },
      { key: 'created_at', label: 'Created' },
      { key: 'sent_at', label: 'Sent' },
    ],
    sql: `SELECT n.channel, n.template_key, n.status, n.error, n.created_at, n.sent_at
            FROM notifications n WHERE n.org_id = ?`,
    dateExpression: 'n.created_at',
  },
  {
    id: 'audit',
    title: 'Audit activity',
    category: 'Governance',
    description: 'Recorded system actions and responsible users.',
    permission: 'audit.view',
    columns: [
      { key: 'created_at', label: 'When' },
      { key: 'actor', label: 'Actor' },
      { key: 'action', label: 'Action' },
      { key: 'entity_type', label: 'Record type' },
      { key: 'entity_id', label: 'Record ID' },
    ],
    sql: `SELECT a.created_at, u.full_name AS actor, a.action, a.entity_type, a.entity_id
            FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id AND u.org_id = a.org_id
           WHERE a.org_id = ?`,
    dateExpression: 'a.created_at',
  },
];

export const visibleReports = (perms: readonly string[]): ReportDefinition[] =>
  perms.includes('reports.view') ? REPORTS.filter((r) => perms.includes(r.permission)) : [];

export function parseReportDates(
  from: string | null,
  to: string | null,
): { from: string; until: string } | null {
  const valid = (value: string | null) => {
    if (!value) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  if (!valid(from) || !valid(to) || (from && to && from > to)) return null;
  const next = to ? new Date(`${to}T00:00:00.000Z`) : null;
  if (next) next.setUTCDate(next.getUTCDate() + 1);
  return { from: from || '0000-01-01', until: next?.toISOString().slice(0, 10) || '9999-12-31' };
}

export async function runReport(
  db: Client,
  orgId: string,
  report: ReportDefinition,
  dates: { from: string; until: string },
  limit: number,
): Promise<(string | number)[][]> {
  const result = await db.execute({
    sql: `${report.sql} AND ${report.dateExpression} >= ? AND ${report.dateExpression} < ?
      ORDER BY ${report.dateExpression} DESC LIMIT ?`,
    args: [orgId, dates.from, dates.until, limit],
  });
  return result.rows.map((row) =>
    report.columns.map((col) => {
      const value = row[col.key];
      if (value == null) return '';
      return col.money ? Number(value) / 100 : typeof value === 'number' ? value : String(value);
    }),
  );
}
