/**
 * The Word export: the WordprocessingML part builder (wordml) and the stored-ZIP
 * writer (zip), both dependency-free leaves so node runs them directly. These pin
 * that the document part carries the report's content and branding, that the ZIP
 * is a valid archive Word can open, and that the CRC matches the known check value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReportDocument } from '../../src/lib/grc/reports/reportTypes.ts';
import {
  reportDocumentParts,
  documentXml,
  reportFilename,
  esc,
} from '../../src/lib/grc/reports/docx/wordml.ts';
import { makeZip, crc32 } from '../../src/lib/grc/reports/docx/zip.ts';

function sampleDoc(): ReportDocument {
  return {
    header: {
      organisation: 'Hass Petroleum Group',
      documentTitle: 'Internal Audit Report',
      reportLabel: 'Executive Summary',
      generatedAt: '2026-07-04',
      filterSummary: 'Year: All years · Risk: All',
    },
    blocks: [
      { kind: 'kpis', items: [{ label: 'Total observations', value: '4' }] },
      {
        kind: 'table',
        title: 'Risk distribution',
        columns: ['Risk', 'Count'],
        rows: [
          [
            { text: 'Extreme', tone: 'risk-extreme' },
            { text: '1', align: 'right' },
          ],
        ],
      },
    ],
  };
}

test('esc escapes XML metacharacters', () => {
  assert.equal(esc('a & b < c > "d" \'e\''), 'a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
});

test('document.xml carries the header, the report label and a table header', () => {
  const xml = documentXml(sampleDoc());
  assert.ok(xml.includes('Hass Petroleum Group'));
  assert.ok(xml.includes('Internal Audit Report'));
  assert.ok(xml.includes('Risk distribution'));
  assert.ok(xml.includes('<w:tbl>'));
  assert.ok(xml.startsWith('<?xml'));
});

test('the package has the five OOXML parts', () => {
  const names = reportDocumentParts(sampleDoc()).map((p) => p.name);
  assert.deepEqual(names, [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/styles.xml',
    'word/_rels/document.xml.rels',
  ]);
});

test('crc32 matches the standard check value for "123456789"', () => {
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(crc32(bytes) >>> 0, 0xcbf43926);
});

test('makeZip produces a valid archive: PK signature and end-of-central-directory', () => {
  const encoder = new TextEncoder();
  const entries = reportDocumentParts(sampleDoc()).map((p) => ({
    name: p.name,
    data: encoder.encode(p.xml),
  }));
  const zip = makeZip(entries);
  // Local file header signature "PK\x03\x04".
  assert.deepEqual([...zip.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  // End-of-central-directory signature 0x06054b50 appears in the tail.
  const eocd = [0x50, 0x4b, 0x05, 0x06];
  let found = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (
      zip[i] === eocd[0] &&
      zip[i + 1] === eocd[1] &&
      zip[i + 2] === eocd[2] &&
      zip[i + 3] === eocd[3]
    ) {
      found = i;
      break;
    }
  }
  assert.ok(found >= 0, 'end-of-central-directory record present');
  // Total-entries field in the EOCD equals the five parts.
  assert.equal(zip[found + 10] | (zip[found + 11] << 8), 5);
});

test('narrative Markdown survives into WordML: marks, headings and lists', () => {
  const doc = sampleDoc();
  doc.blocks = [
    {
      kind: 'narrative',
      text: '## Findings\nManagement **must** act *now*.\n- first control\n- second control\n1. do this\n2. then this',
    },
    { kind: 'list', title: 'Recommendations', items: ['Fix **all** reconciliations'] },
  ];
  const xml = documentXml(doc);
  // Bold and italic runs, not one flat run.
  assert.ok(xml.includes('<w:b/>'), 'a bold run is emitted');
  assert.ok(xml.includes('<w:i/>'), 'an italic run is emitted');
  assert.ok(xml.includes('>must<'), 'the bold text is its own run');
  // The heading renders as its own styled paragraph, without the ## marker.
  assert.ok(xml.includes('>Findings<'));
  assert.ok(!xml.includes('##'), 'no raw Markdown markers leak into the pack');
  assert.ok(!xml.includes('**'), 'no raw bold markers leak into the pack');
  // Bullets and inline numbering, indented.
  assert.ok(xml.includes('• '), 'bullet items are marked');
  assert.ok(xml.includes('>1. <') || xml.includes('1. '), 'numbered items are numbered');
  assert.ok(xml.includes('<w:ind w:left="360"/>'), 'list items are indented');
  // A list block item with inline marks keeps them.
  assert.ok(xml.includes('>all<'), 'inline marks inside list items are separate runs');
});

test('reportFilename is filesystem-safe', () => {
  assert.equal(reportFilename('executive', '2026-07-04'), 'board-report-executive-2026-07-04.docx');
  assert.equal(
    reportFilename('Overdue and At-Risk', '2026-07-04'),
    'board-report-overdue-and-at-risk-2026-07-04.docx',
  );
});
