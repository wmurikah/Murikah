import type { ReportDefinition } from './catalog';

export type ReportFormat = 'xlsx' | 'docx' | 'pdf' | 'svg' | 'csv';
const xml = (value: unknown) =>
  String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, ' ')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const encoder = new TextEncoder();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A small standards-compliant ZIP writer (stored entries). It avoids Node APIs
 * and extra Worker dependencies for the two Office Open XML exports. */
function zip(files: readonly [string, string][]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  const u16 = (view: DataView, at: number, n: number) => view.setUint16(at, n, true);
  const u32 = (view: DataView, at: number, n: number) => view.setUint32(at, n, true);
  for (const [name, contents] of files) {
    const path = encoder.encode(name);
    const body = encoder.encode(contents);
    const crc = crc32(body);
    const head = new Uint8Array(30 + path.length);
    const hv = new DataView(head.buffer);
    u32(hv, 0, 0x04034b50);
    u16(hv, 4, 20);
    u16(hv, 8, 0);
    u32(hv, 14, crc);
    u32(hv, 18, body.length);
    u32(hv, 22, body.length);
    u16(hv, 26, path.length);
    head.set(path, 30);
    chunks.push(head, body);
    const central = new Uint8Array(46 + path.length);
    const cv = new DataView(central.buffer);
    u32(cv, 0, 0x02014b50);
    u16(cv, 4, 20);
    u16(cv, 6, 20);
    u32(cv, 16, crc);
    u32(cv, 20, body.length);
    u32(cv, 24, body.length);
    u16(cv, 28, path.length);
    u32(cv, 42, offset);
    central.set(path, 46);
    directory.push(central);
    offset += head.length + body.length;
  }
  const dirSize = directory.reduce((n, p) => n + p.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  u32(ev, 0, 0x06054b50);
  u16(ev, 8, files.length);
  u16(ev, 10, files.length);
  u32(ev, 12, dirSize);
  u32(ev, 16, offset);
  const output = new Uint8Array(offset + dirSize + end.length);
  let at = 0;
  for (const part of [...chunks, ...directory, end]) {
    output.set(part, at);
    at += part.length;
  }
  return output;
}

function xlsx(
  report: ReportDefinition,
  rows: readonly (readonly (string | number)[])[],
): Uint8Array {
  const all = [report.columns.map((c) => c.label), ...rows];
  const sheet = all
    .map(
      (row, ri) =>
        `<row r="${ri + 1}">${row
          .map((value, ci) => {
            let n = ci + 1;
            let letters = '';
            while (n) {
              n--;
              letters = String.fromCharCode(65 + (n % 26)) + letters;
              n = Math.floor(n / 26);
            }
            const ref = `${letters}${ri + 1}`;
            return typeof value === 'number' && Number.isFinite(value)
              ? `<c r="${ref}"><v>${value}</v></c>`
              : `<c r="${ref}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
          })
          .join('')}</row>`,
    )
    .join('');
  return zip([
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ],
    [
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(report.title.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`,
    ],
  ]);
}

function docx(
  report: ReportDefinition,
  rows: readonly (readonly (string | number)[])[],
): Uint8Array {
  const paragraph = (value: unknown) =>
    `<w:p><w:r><w:t xml:space="preserve">${xml(value)}</w:t></w:r></w:p>`;
  const tableRow = (cells: readonly (string | number)[]) =>
    `<w:tr>${cells.map((c) => `<w:tc>${paragraph(c)}</w:tc>`).join('')}</w:tr>`;
  const table = `<w:tbl>${tableRow(report.columns.map((c) => c.label))}${rows.map(tableRow).join('')}</w:tbl>`;
  return zip([
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ],
    [
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ],
    [
      'word/document.xml',
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph(report.title)}${paragraph(report.description)}${paragraph(`Generated ${new Date().toISOString().slice(0, 10)} · ${rows.length} records`)}${table}<w:sectPr/></w:body></w:document>`,
    ],
  ]);
}

function pdf(
  report: ReportDefinition,
  rows: readonly (readonly (string | number)[])[],
): Uint8Array {
  // Built-in PDF font supports Latin-1; replace unsupported characters instead
  // of emitting malformed bytes. One field per line keeps wide tables legible.
  const plain = (v: unknown) =>
    String(v ?? '')
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '?');
  const escape = (v: string) =>
    v.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const lines: string[] = [
    report.title,
    report.description,
    `Generated ${new Date().toISOString().slice(0, 10)} | ${rows.length} records`,
    '',
  ];
  rows.forEach((row, index) => {
    lines.push(`Record ${index + 1}`);
    row.forEach((value, ci) => {
      const field = `${report.columns[ci].label}: ${plain(value)}`;
      for (let i = 0; i < field.length; i += 105) lines.push(field.slice(i, i + 105));
    });
    lines.push('');
  });
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 55) pages.push(lines.slice(i, i + 55));
  const objects: string[] = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const kids: string[] = [];
  pages.forEach((page, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    kids.push(`${pageId} 0 R`);
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = `BT /F1 9 Tf 36 755 Td 12 TL ${page.map((line, i) => `${i ? 'T* ' : ''}(${escape(plain(line))}) Tj`).join('\n')} ET`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = output.length;
    output += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = output.length;
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++)
    output += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return encoder.encode(output);
}

function svg(
  report: ReportDefinition,
  rows: readonly (readonly (string | number)[])[],
): Uint8Array {
  const groupKey =
    ['status', 'to_region_name', 'region', 'station', 'contractor', 'action'].find((key) =>
      report.columns.some((column) => column.key === key),
    ) ?? report.columns[0].key;
  const groupIndex = report.columns.findIndex((column) => column.key === groupKey);
  const counts = new Map<string, number>();
  for (const row of rows) {
    const label = String(row[groupIndex] || 'Not set');
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const groups = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const largest = Math.max(1, ...groups.map((entry) => entry[1]));
  const summary = groups
    .map(([name, count], index) => {
      const y = 142 + index * 32;
      const width = Math.round((count / largest) * 480);
      return `<text x="32" y="${y}" font-size="14" fill="#1d2a44">${xml(name.slice(0, 32))}</text><rect x="365" y="${y - 16}" width="${width}" height="20" rx="4" fill="#d3aa2d"/><text x="${375 + width}" y="${y}" font-size="14" fill="#1d2a44">${count}</text>`;
    })
    .join('');
  return encoder.encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="510" viewBox="0 0 1000 510"><rect width="1000" height="510" fill="#f9f6ed"/><rect x="0" y="0" width="1000" height="12" fill="#d3aa2d"/><text x="32" y="55" font-size="30" font-family="Arial" font-weight="bold" fill="#0a1735">${xml(report.title)}</text><text x="32" y="86" font-size="16" font-family="Arial" fill="#5a6880">${xml(`${rows.length} records · grouped by ${report.columns[groupIndex].label}`)}</text><g font-family="Arial">${summary}</g><text x="32" y="485" font-size="13" font-family="Arial" fill="#5a6880">Engineering Rhythm · ${new Date().toISOString().slice(0, 10)}</text></svg>`,
  );
}

function csv(
  report: ReportDefinition,
  rows: readonly (readonly (string | number)[])[],
): Uint8Array {
  const cell = (value: string | number) => {
    const raw = String(value ?? '');
    const safe = typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return encoder.encode(
    `\ufeff${[report.columns.map((c) => c.label), ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`,
  );
}

export function renderReport(
  report: ReportDefinition,
  rows: readonly (readonly (string | number)[])[],
  format: ReportFormat,
): { body: Uint8Array; contentType: string } {
  switch (format) {
    case 'xlsx':
      return {
        body: xlsx(report, rows),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    case 'docx':
      return {
        body: docx(report, rows),
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      };
    case 'pdf':
      return { body: pdf(report, rows), contentType: 'application/pdf' };
    case 'svg':
      return { body: svg(report, rows), contentType: 'image/svg+xml' };
    case 'csv':
      return { body: csv(report, rows), contentType: 'text/csv; charset=utf-8' };
  }
}
