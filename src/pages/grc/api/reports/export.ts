export const prerender = false;

/**
 * Export the selected board report as a Word (.docx) document, the port of
 * generateBoardReport. Gate: REPORTS.view and REPORTS.board. The same scoped
 * aggregation and pure model that drive the preview build the document here, so
 * the download matches the preview; the role scope is enforced server-side and
 * the export is recorded in audit_log. The document is generated with the
 * dependency-free OOXML writer, so it runs on the Worker with no external library.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { can } from '@grc/auth/rbac';
import { listAffiliates, listAuditAreas } from '@grc/repos/workPaperLookups';
import { loadEnumLabels } from '@grc/repos/enums';
import { writeAuditLog } from '@grc/repos/audit';
import {
  parseReportFilters,
  filterSummary,
  reportTypeLabel,
  isUnitManagerScope,
  buildReport,
  ymd,
} from '@grc/reports/reportModel';
import { getComprehensiveReportData, resolveUserAffiliate } from '@grc/repos/reportData';
import { renderReportDocx, reportFilename } from '@grc/reports/docx/ooxml';

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response('Unauthorised', { status: 401 });
  // Generating a document is the export action on the REPORT module, so the
  // matrix decides it. Reading a report on screen is a separate, weaker grant:
  // a role may be allowed to look without being allowed to take the document
  // away, and gating both on read would have collapsed that distinction.
  if (!can(locals, 'export', 'REPORT')) {
    return new Response('You do not have permission to export board reports.', { status: 403 });
  }

  const form = await request.formData();
  const params = new URLSearchParams();
  for (const [k, v] of form.entries()) params.append(k, String(v));

  const now = new Date();
  const db = await getDb(getGrcEnv());
  const unitScope = isUnitManagerScope(grc.roleCode, grc.isPlatformOwner);
  const forcedAffiliate = unitScope
    ? await resolveUserAffiliate(db, grc.organizationId, grc.userId)
    : null;
  const filters = parseReportFilters(
    params,
    {
      roleCode: grc.roleCode,
      isPlatformOwner: grc.isPlatformOwner,
      forcedAffiliateCode: forcedAffiliate,
    },
    now,
  );

  const [dataset, affiliates, auditAreas, wpLabels, apLabels] = await Promise.all([
    getComprehensiveReportData(
      db,
      grc.organizationId,
      { userId: grc.userId, roleCode: grc.roleCode, isPlatformOwner: grc.isPlatformOwner },
      filters,
      forcedAffiliate,
    ),
    listAffiliates(db, grc.organizationId),
    listAuditAreas(db, grc.organizationId),
    loadEnumLabels(db, 'WORK_PAPER_STATUS'),
    loadEnumLabels(db, 'ACTION_PLAN_STATUS'),
  ]);
  const statusLabels: Record<string, string> = {};
  for (const [k, v] of wpLabels) statusLabels[k] = v;
  for (const [k, v] of apLabels) statusLabels[k] = v;

  const affiliateName = filters.affiliateCode
    ? (affiliates.find((a) => a.id === filters.affiliateCode)?.label ?? filters.affiliateCode)
    : null;
  const auditAreaName = filters.auditAreaId
    ? (auditAreas.find((a) => a.id === filters.auditAreaId)?.label ?? filters.auditAreaId)
    : null;
  const summary = filterSummary(filters, { affiliateName, auditAreaName });

  const doc = buildReport(dataset, filters, {
    header: {
      organisation: grc.organizationName,
      documentTitle: 'Internal Audit Report',
      reportLabel: reportTypeLabel(filters.reportType),
      generatedAt: ymd(now),
      filterSummary: summary,
      scopeNotice: unitScope
        ? 'Scoped to your affiliate and the observations and action plans assigned to you.'
        : undefined,
    },
    now,
    statusLabels,
  });

  const bytes = renderReportDocx(doc);
  const filename = reportFilename(filters.reportType, ymd(now));

  try {
    await writeAuditLog(db, {
      organizationId: grc.organizationId,
      userId: grc.userId,
      action: 'REPORT.export',
      details: `${filters.reportType}: ${summary}`,
    });
  } catch {
    // best-effort audit
  }

  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  return new Response(blob, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
};
