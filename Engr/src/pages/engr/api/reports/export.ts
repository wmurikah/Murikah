export const prerender = false;

import type { APIRoute } from 'astro';
import { getDb } from '@engr/db';
import { getEngrEnv } from '@engr/env';

const csv = (value: unknown): string => {
  const raw = String(value ?? '');
  // Spreadsheet applications execute formula-looking text even inside quoted
  // CSV cells. Prefix user-controlled text while leaving numeric amounts numeric.
  const safe = typeof value === 'string' && /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
};

/** Organisation-scoped operational export. Finance records remain behind their
 * own permissions and are not mixed into this general engineering report. */
export const GET: APIRoute = async ({ locals }) => {
  const engr = locals.engr;
  if (!engr) return new Response('Unauthorised', { status: 401 });
  if (!engr.perms.includes('reports.export')) return new Response('Forbidden', { status: 403 });

  const db = await getDb(getEngrEnv(), locals);
  let lines: string[];
  let fileName: string;
  if (engr.perms.includes('workorder.view')) {
    const result = await db.execute({
      sql: `SELECT wo.wo_no, wo.status, wo.source, wo.created_at, wo.closed_at,
                 s.code AS station_code, s.name AS station_name,
                 c.name AS contractor_name, t.full_name AS technician_name
            FROM work_orders wo
            JOIN stations s ON s.id = wo.station_id AND s.org_id = wo.org_id
       LEFT JOIN contractors c ON c.id = wo.contractor_id AND c.org_id = wo.org_id
       LEFT JOIN technicians t ON t.id = wo.technician_id AND t.org_id = wo.org_id
           WHERE wo.org_id = ? AND wo.deleted_at IS NULL
        ORDER BY wo.created_at DESC`,
      args: [engr.orgId],
    });
    const header = [
      'Work order',
      'Status',
      'Source',
      'Station code',
      'Station',
      'Contractor',
      'Technician',
      'Created at',
      'Closed at',
    ];
    lines = [header.map(csv).join(',')];
    for (const row of result.rows) {
      lines.push(
        [
          row.wo_no,
          row.status,
          row.source,
          row.station_code,
          row.station_name,
          row.contractor_name,
          row.technician_name,
          row.created_at,
          row.closed_at,
        ]
          .map(csv)
          .join(','),
      );
    }
    fileName = 'engineering-work-orders';
  } else if (engr.perms.includes('bill.view')) {
    const result = await db.execute({
      sql: `SELECT b.bill_no, b.status, b.period_label, b.subtotal_minor, b.vat_minor,
                   b.total_minor, b.currency, b.submitted_at, b.approved_at, c.name AS contractor_name
              FROM bills b JOIN contractors c ON c.id = b.contractor_id AND c.org_id = b.org_id
             WHERE b.org_id = ? ORDER BY b.created_at DESC`,
      args: [engr.orgId],
    });
    const header = [
      'Bill',
      'Contractor',
      'Status',
      'Period',
      'Subtotal minor',
      'VAT minor',
      'Total minor',
      'Currency',
      'Submitted at',
      'Approved at',
    ];
    lines = [header.map(csv).join(',')];
    for (const row of result.rows) {
      lines.push(
        [
          row.bill_no,
          row.contractor_name,
          row.status,
          row.period_label,
          row.subtotal_minor,
          row.vat_minor,
          row.total_minor,
          row.currency,
          row.submitted_at,
          row.approved_at,
        ]
          .map(csv)
          .join(','),
      );
    }
    fileName = 'engineering-bills';
  } else {
    return new Response('Forbidden', { status: 403 });
  }
  const day = new Date().toISOString().slice(0, 10);
  return new Response(`\ufeff${lines.join('\r\n')}\r\n`, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${fileName}-${day}.csv"`,
      'cache-control': 'private, no-store',
    },
  });
};
