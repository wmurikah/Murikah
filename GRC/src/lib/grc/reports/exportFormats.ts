import type { ReportBlock, ReportDocument } from './reportTypes';
import { makeZip, type ZipEntry } from './docx/zip';

export type ReportExportFormat = 'docx' | 'csv' | 'xlsx' | 'pdf' | 'svg';

function blockLines(block: ReportBlock): string[] {
  switch (block.kind) {
    case 'heading':
      return [block.text];
    case 'narrative':
    case 'note':
      return [block.text];
    case 'list':
      return [
        block.title ?? '',
        ...block.items.map((v, i) => `${block.ordered ? `${i + 1}.` : '-'} ${v}`),
      ];
    case 'kpis':
      return block.items.map((item) => `${item.label}: ${item.value}`);
    case 'table':
    case 'group':
      return [
        block.title ?? '',
        block.columns.join(' | '),
        ...block.rows.map((r) => r.map((c) => c.text).join(' | ')),
      ];
    case 'finding': {
      const s = block.source;
      return [
        `${s.reference}: ${s.observationTitle}`,
        `Status: ${s.status} | Risk: ${s.riskRating ?? 'Unrated'}`,
        `Affiliate: ${s.affiliate} | Audit area: ${s.auditArea}`,
        s.observationDescription,
        `Risk: ${s.riskSummary}`,
        `Recommendation: ${s.recommendation}`,
        `Management response: ${s.managementResponse}`,
        ...(s.actionPlans ?? []).map(
          (p) => `Action: ${p.description} | ${p.owner} | ${p.due} | ${p.status}`,
        ),
      ];
    }
  }
}

export function reportLines(doc: ReportDocument): string[] {
  return [
    doc.header.organisation,
    doc.header.documentTitle,
    doc.header.reportLabel,
    `Generated: ${doc.header.generatedAt}`,
    doc.header.filterSummary,
    doc.header.scopeNotice ?? '',
    '',
    ...doc.blocks.flatMap((b) => [...blockLines(b), '']),
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '');
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function renderReportCsv(doc: ReportDocument): Uint8Array {
  const rows = reportLines(doc).map((line) => csvCell(line));
  return new TextEncoder().encode(`\uFEFF${rows.join('\r\n')}\r\n`);
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Dependency-free OOXML workbook, opened natively by Excel. */
export function renderReportExcel(doc: ReportDocument): Uint8Array<ArrayBuffer> {
  const rows = reportLines(doc)
    .map(
      (line, i) =>
        `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t xml:space="preserve">${xml(line)}</t></is></c></row>`,
    )
    .join('');
  const parts: { name: string; xml: string }[] = [
    {
      name: '[Content_Types].xml',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="120" customWidth="1"/></cols><sheetData>${rows}</sheetData></worksheet>`,
    },
  ];
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = parts.map((p) => ({ name: p.name, data: encoder.encode(p.xml) }));
  return makeZip(entries);
}

function ascii(value: string): string {
  return value.normalize('NFKD').replace(/[^\x20-\x7E]/g, '?');
}

function wrap(value: string, width = 92): string[] {
  const words = ascii(value).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line += `${line ? ' ' : ''}${word}`;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function pdfEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** Small text PDF renderer suitable for Worker execution and archival export. */
export function renderReportPdf(doc: ReportDocument): Uint8Array {
  const lines = reportLines(doc).flatMap((line) => wrap(line));
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 48) pages.push(lines.slice(i, i + 48));
  if (pages.length === 0) pages.push(['']);

  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const pageIds = pages.map((_, i) => 4 + i * 2);
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((page, i) => {
    const pageId = pageIds[i];
    const contentId = pageId + 1;
    const body = `BT /F1 9 Tf 48 790 Td 12 TL ${page.map((line, n) => `${n ? 'T* ' : ''}(${pdfEscape(line)}) Tj`).join(' ')} ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++)
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer << /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

/** SVG is the image export: readable, scalable and dependency-free. */
export function renderReportSvg(doc: ReportDocument): Uint8Array {
  const lines = reportLines(doc).flatMap((line) => wrap(line, 110));
  const height = Math.max(240, 70 + lines.length * 18);
  const text = lines
    .map(
      (line, i) =>
        `<text x="40" y="${55 + i * 18}" font-size="12" fill="#0b1a3b">${xml(line)}</text>`,
    )
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}"><rect width="100%" height="100%" fill="#fbf8f0"/><g font-family="Arial, sans-serif">${text}</g></svg>`;
  return new TextEncoder().encode(svg);
}
