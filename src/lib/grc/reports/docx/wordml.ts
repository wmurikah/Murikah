/**
 * Build the WordprocessingML parts of a .docx from a generic ReportDocument. A
 * .docx is an Office Open XML package: a ZIP of a small set of XML parts. This
 * emits those parts from the same document the HTML preview renders, so the
 * exported file matches the preview's structure and branding (navy #1a365d and
 * gold #C9A83E map to the brand tokens). Zipping is left to the caller.
 *
 * Imports are types only, so node can strip types and unit-test the XML output.
 */
import type { Cell, Kpi, ReportBlock, ReportDocument, Tone } from '../reportTypes';
import { parseRichText, parseInlines, type RichBlock, type RichInline } from '../../richtext.ts';
import { cardIsEmpty, findingHeader, visibleCards, type FindingSource } from '../findingCards.ts';

const NAVY = '1A365D';
const GOLD = 'C9A83E';
const WHITE = 'FFFFFF';
const LINE = 'D8D1C3';

const TONE_COLOUR: Record<Tone, string> = {
  default: '111827',
  good: '1E7A34',
  warn: '8A5A00',
  bad: 'B02A1A',
  muted: '6B7280',
  'risk-extreme': '7A271A',
  'risk-high': 'B45309',
  'risk-medium': '7A4F16',
  'risk-low': '1E4D2B',
};

function toneColour(tone: Tone | undefined): string {
  return tone ? TONE_COLOUR[tone] : TONE_COLOUR.default;
}

/** XML-escape text for a WordprocessingML run. */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface RunOpts {
  bold?: boolean;
  caps?: boolean;
  italic?: boolean;
  colour?: string;
  /** Half-points (e.g. 36 = 18pt). */
  size?: number;
}

function run(text: string, opts: RunOpts = {}): string {
  const rpr: string[] = [];
  if (opts.bold) rpr.push('<w:b/>');
  if (opts.italic) rpr.push('<w:i/>');
  if (opts.caps) rpr.push('<w:caps/>');
  if (opts.colour) rpr.push(`<w:color w:val="${opts.colour}"/>`);
  if (opts.size != null) rpr.push(`<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>`);
  const rPr = rpr.length ? `<w:rPr>${rpr.join('')}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

interface ParaOpts {
  align?: 'left' | 'right' | 'center';
  after?: number;
  /** Space above the paragraph, so a section heading breathes. */
  before?: number;
  rule?: boolean;
  /** Left indent in twentieths of a point, for list items. */
  indent?: number;
}

function para(runsXml: string, opts: ParaOpts = {}): string {
  const ppr: string[] = [];
  if (opts.rule) {
    ppr.push(`<w:pBdr><w:bottom w:val="single" w:sz="12" w:color="${GOLD}" w:space="2"/></w:pBdr>`);
  }
  if (opts.align) ppr.push(`<w:jc w:val="${opts.align}"/>`);
  if (opts.indent) ppr.push(`<w:ind w:left="${opts.indent}"/>`);
  ppr.push(
    `<w:spacing${opts.before ? ` w:before="${opts.before}"` : ''} w:after="${opts.after ?? 120}"/>`,
  );
  return `<w:p><w:pPr>${ppr.join('')}</w:pPr>${runsXml}</w:p>`;
}

/** One line's rich inlines as WordML runs: bold and italic marks survive. */
function inlineRuns(inlines: RichInline[], opts: RunOpts): string {
  if (inlines.length === 0) return run('', opts);
  return inlines
    .map((r) =>
      run(r.text, { ...opts, bold: opts.bold || r.bold, italic: opts.italic || r.italic }),
    )
    .join('');
}

/**
 * A narrative's Markdown as WordML: paragraphs with inline marks, bold navy
 * headings, and list items numbered inline (no numbering.xml part needed).
 */
function richBlockXml(b: RichBlock): string {
  if (b.kind === 'heading') {
    return para(
      inlineRuns(b.inlines, { bold: true, size: b.level === 2 ? 24 : 21, colour: NAVY }),
      {
        before: 120,
        after: 60,
      },
    );
  }
  if (b.kind === 'list') {
    return b.items
      .map((item, i) =>
        para(run(b.ordered ? `${i + 1}. ` : '• ', { size: 20 }) + inlineRuns(item, { size: 20 }), {
          after: 40,
          indent: 360,
        }),
      )
      .join('');
  }
  return para(inlineRuns(b.inlines, { size: 20 }), { after: 120 });
}

const TBL_BORDERS = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  .map((e) => `<w:${e} w:val="single" w:sz="4" w:color="${LINE}"/>`)
  .join('')}</w:tblBorders>`;

function cellXml(
  text: string,
  opts: { header?: boolean; tone?: Tone; align?: 'left' | 'right' },
): string {
  const colour = opts.header ? WHITE : toneColour(opts.tone);
  const shade = opts.header ? `<w:shd w:val="clear" w:color="auto" w:fill="${NAVY}"/>` : '';
  const p = para(run(text, { bold: opts.header, colour, size: 18 }), {
    align: opts.align === 'right' ? 'right' : 'left',
    after: 0,
  });
  return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${shade}</w:tcPr>${p}</w:tc>`;
}

function tableXml(columns: string[], rows: Cell[][]): string {
  const header = `<w:tr>${columns.map((c) => cellXml(c, { header: true })).join('')}</w:tr>`;
  const body = rows
    .map(
      (r) =>
        `<w:tr>${r.map((cell) => cellXml(cell.text, { tone: cell.tone, align: cell.align })).join('')}</w:tr>`,
    )
    .join('');
  const tblPr = `<w:tblPr><w:tblW w:w="5000" w:type="pct"/>${TBL_BORDERS}<w:tblLayout w:type="autofit"/></w:tblPr>`;
  return `<w:tbl>${tblPr}${header}${body}</w:tbl>`;
}

function kpiTableXml(items: Kpi[]): string {
  const cells = items
    .map((k) => {
      const value = para(run(k.value, { bold: true, size: 40, colour: toneColour(k.tone) }), {
        after: 0,
      });
      const label = para(run(k.label, { caps: true, size: 16, colour: TONE_COLOUR.muted }), {
        after: 0,
      });
      return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${value}${label}</w:tc>`;
    })
    .join('');
  const tblPr = `<w:tblPr><w:tblW w:w="5000" w:type="pct"/>${TBL_BORDERS}<w:tblLayout w:type="autofit"/></w:tblPr>`;
  return `<w:tbl>${tblPr}<w:tr>${cells}</w:tr></w:tbl>`;
}

/** The colour Word paints a risk rating, matched to the pill on the screen. */
const RISK_COLOUR: Record<string, string> = {
  extreme: '6B1610',
  high: '8A2117',
  medium: '6B4E12',
  low: '1C4C31',
};

/**
 * A finding as the shared card arrangement, rendered for Word.
 *
 * The strip is a two-column facts table, each card a bold heading over its
 * body, and the risk rating is coloured to match its pill. A card with nothing
 * in it prints its quiet line rather than a heading over blank paper, exactly
 * as on screen: a board reading a pack should be told the response is
 * outstanding, not left to wonder whether it was omitted.
 */
function findingXml(source: FindingSource): string {
  const header = findingHeader(source);
  const parts: string[] = [];
  parts.push(
    para(
      run(header.reference, { bold: true, size: 20, colour: TONE_COLOUR.muted }) +
        run('    ', { size: 20 }) +
        run(header.risk.srLabel, {
          bold: true,
          size: 20,
          colour: RISK_COLOUR[header.risk.tone ?? ''] ?? TONE_COLOUR.muted,
        }),
      { after: 40 },
    ),
  );
  parts.push(
    tableXml(
      ['Affiliate', 'Audit area', 'Status'],
      [[{ text: header.affiliate }, { text: header.auditArea }, { text: header.status }]],
    ),
    para(''),
  );
  for (const card of visibleCards(source)) {
    parts.push(para(run(card.heading, { bold: true, size: 24, colour: NAVY }), { after: 60 }));
    if (cardIsEmpty(card)) {
      parts.push(
        para(run(card.emptyText ?? '', { italic: true, size: 20, colour: TONE_COLOUR.muted }), {
          after: 120,
        }),
      );
      continue;
    }
    for (const body of card.body) {
      if (body.kind === 'rich') {
        const rich = parseRichText(body.text);
        parts.push(rich.length === 0 ? para('') : rich.map(richBlockXml).join(''));
      } else if (body.kind === 'facts') {
        for (const fact of body.facts.filter((f) => String(f.value ?? '').trim() !== '')) {
          parts.push(
            para(
              run(`${fact.label}: `, { bold: true, size: 20, colour: TONE_COLOUR.muted }) +
                run(fact.value, { size: 20 }),
              { after: 40 },
            ),
          );
        }
      } else {
        parts.push(
          tableXml(
            body.columns,
            body.rows.map((row) => row.map((cell) => ({ text: cell }))),
          ),
          para(''),
        );
      }
    }
  }
  return parts.join('');
}

function blockXml(block: ReportBlock): string {
  switch (block.kind) {
    case 'kpis':
      return kpiTableXml(block.items) + para('');
    case 'table': {
      const heading = block.title
        ? para(run(block.title, { bold: true, size: 26, colour: NAVY }), { after: 80 })
        : '';
      return heading + tableXml(block.columns, block.rows) + para('');
    }
    case 'group': {
      const heading = para(run(block.title, { bold: true, size: 26, colour: NAVY }), { after: 40 });
      const subtitle = block.subtitle
        ? para(run(block.subtitle, { size: 18, colour: TONE_COLOUR.muted }), { after: 40 })
        : '';
      const badges = block.badges?.length
        ? para(
            block.badges
              .map((b, i) =>
                run((i ? '  ·  ' : '') + b.text, {
                  size: 18,
                  colour: toneColour(b.tone),
                  bold: true,
                }),
              )
              .join(''),
            { after: 60 },
          )
        : '';
      return heading + subtitle + badges + tableXml(block.columns, block.rows) + para('');
    }
    // One finding, as the same header strip and cards the screen draws
    // (Build Prompt 67). Word has no card, so a card becomes what a card is on
    // paper: a bold heading over its content, with the strip as a small facts
    // table and the risk rating carrying the colour the pill carries. The
    // arrangement comes from the shared model, so the order and the headings
    // are the screen's, not a second opinion about them.
    case 'finding':
      return findingXml(block.source);
    case 'note':
      return para(run(block.text, { italic: true, size: 20, colour: TONE_COLOUR.muted }));
    case 'heading':
      // A section heading: the level-1 parts of the house structure, and the
      // level-2 headings of each observation within them.
      return para(
        run(block.text, {
          bold: true,
          size: block.level === 1 ? 32 : 26,
          colour: block.level === 1 ? NAVY : GOLD,
        }),
        { before: block.level === 1 ? 240 : 160, after: 80 },
      );
    case 'narrative': {
      // The narrative carries the Markdown subset; its marks, headings and
      // lists survive into the pack rather than collapsing to one plain run.
      const rich = parseRichText(block.text);
      if (rich.length === 0) return para(run('', { size: 20 }), { after: 120 });
      return rich.map(richBlockXml).join('');
    }
    case 'list': {
      const heading = block.title
        ? para(run(block.title, { bold: true, size: 22, colour: NAVY }), { after: 40 })
        : '';
      // Numbered inline rather than through a numbering part, so the document
      // needs no numbering.xml and still reads as an ordered list. Items may
      // carry inline marks.
      const items = block.items
        .map((item, i) =>
          para(
            run(`${block.ordered === false ? '•' : `${i + 1}.`} `, { size: 20 }) +
              inlineRuns(parseInlines(item), { size: 20 }),
            { after: 40 },
          ),
        )
        .join('');
      return heading + items + para('');
    }
    default:
      return '';
  }
}

function headerXml(doc: ReportDocument): string {
  const h = doc.header;
  const parts = [
    para(run(h.organisation, { bold: true, caps: true, size: 18, colour: GOLD }), { after: 40 }),
    para(run(h.documentTitle, { bold: true, size: 40, colour: NAVY }), { after: 40 }),
    para(run(h.reportLabel, { size: 28, colour: NAVY }), { after: 60, rule: true }),
    para(run(`Generated ${h.generatedAt}`, { size: 18, colour: TONE_COLOUR.muted }), { after: 20 }),
    para(run(h.filterSummary, { size: 16, colour: TONE_COLOUR.muted }), {
      after: h.scopeNotice ? 20 : 160,
    }),
  ];
  if (h.scopeNotice) {
    parts.push(
      para(run(h.scopeNotice, { italic: true, size: 16, colour: TONE_COLOUR.muted }), {
        after: 160,
      }),
    );
  }
  return parts.join('');
}

const SECT_PR =
  '<w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>' +
  '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>';

/** The word/document.xml body, from the report header and blocks. */
export function documentXml(doc: ReportDocument): string {
  const body = headerXml(doc) + doc.blocks.map(blockXml).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}${SECT_PR}</w:body></w:document>`
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '</Types>';

const RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

const DOC_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '</w:styles>';

export interface DocxPart {
  name: string;
  xml: string;
}

/** The full set of OOXML parts for the .docx package, ready to zip. */
export function reportDocumentParts(doc: ReportDocument): DocxPart[] {
  return [
    { name: '[Content_Types].xml', xml: CONTENT_TYPES },
    { name: '_rels/.rels', xml: RELS },
    { name: 'word/document.xml', xml: documentXml(doc) },
    { name: 'word/styles.xml', xml: STYLES },
    { name: 'word/_rels/document.xml.rels', xml: DOC_RELS },
  ];
}

/** A filesystem-safe filename for a report, e.g. board-report-executive-2026-07-04.docx. */
export function reportFilename(reportType: string, date: string): string {
  const safeType = reportType.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return `board-report-${safeType}-${date}.docx`;
}
