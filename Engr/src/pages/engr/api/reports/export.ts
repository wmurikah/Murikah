export const prerender = false;

import type { APIRoute } from 'astro';
import { getDb } from '@engr/db';
import { getEngrEnv } from '@engr/env';
import { actorDataScope } from '@engr/auth/dataScope';
import { REPORTS, parseReportDates, runReport } from '@engr/reports/catalog';
import { renderReport, type ReportFormat } from '@engr/reports/formats';

const formats = new Set<ReportFormat>(['xlsx', 'docx', 'pdf', 'svg', 'csv']);

export const GET: APIRoute = async ({ request, locals }) => {
  const engr = locals.engr;
  if (!engr) return new Response('Unauthorised', { status: 401 });
  if (!engr.perms.includes('reports.export') || actorDataScope(engr.roles) !== 'org')
    return new Response('Forbidden', { status: 403 });
  const url = new URL(request.url);
  // Preserve the old dashboard link while making report selection explicit on
  // the new centre. Its finance fallback previously selected a nonexistent vat_minor.
  const requested =
    url.searchParams.get('report') ||
    (engr.perms.includes('workorder.view') ? 'work_orders' : 'bills');
  const report = REPORTS.find((r) => r.id === requested);
  if (!report) return new Response('Unknown report', { status: 404 });
  if (!engr.perms.includes(report.permission)) return new Response('Forbidden', { status: 403 });
  const format = (url.searchParams.get('format') || 'csv') as ReportFormat;
  if (!formats.has(format)) return new Response('Unknown export format', { status: 400 });
  const dates = parseReportDates(url.searchParams.get('from'), url.searchParams.get('to'));
  if (!dates) return new Response('Invalid date range', { status: 400 });
  const db = await getDb(getEngrEnv(), locals);
  const rows = await runReport(db, engr.orgId, report, dates, 501);
  if (rows.length > 500)
    return new Response('More than 500 records match. Narrow the date range and export again.', {
      status: 422,
    });
  const { body, contentType } = renderReport(report, rows, format);
  const day = new Date().toISOString().slice(0, 10);
  return new Response(Uint8Array.from(body).buffer, {
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="${report.id}-${day}.${format}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
};
