/**
 * The narrative rich-text format: a constrained Markdown subset that is the
 * Word-grade basics and nothing more. Stored content is plain Markdown text,
 * never HTML, so there is nothing executable at rest; every renderer escapes
 * first and adds its own marks, and unknown syntax simply stays visible as
 * text (nothing is silently dropped).
 *
 *   ## Heading        ### Subheading
 *   **bold**          *italic*
 *   - bullet item     1. numbered item
 *
 * One parser feeds every surface: the HTML rendering on the detail screens and
 * the report preview, the WordML renderer in the board pack, and the editor
 * island round-trips the same syntax. Import-free, so node strips types and
 * unit-tests this directly, and the editor's client bundle can import it too.
 */

export interface RichInline {
  text: string;
  bold: boolean;
  italic: boolean;
}

export type RichBlock =
  | { kind: 'paragraph'; inlines: RichInline[] }
  | { kind: 'heading'; level: 2 | 3; inlines: RichInline[] }
  | { kind: 'list'; ordered: boolean; items: RichInline[][] };

/**
 * Parse the inline marks of one line: **bold** and *italic*, with ***both***
 * handled by parsing bold first and italics inside the remainder. Unbalanced
 * markers stay as literal text.
 */
export function parseInlines(line: string): RichInline[] {
  const out: RichInline[] = [];
  const pushItalicRuns = (text: string, bold: boolean): void => {
    const re = /\*([^*\n]+)\*/g;
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index > last) out.push({ text: text.slice(last, m.index), bold, italic: false });
      out.push({ text: m[1], bold, italic: true });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last), bold, italic: false });
  };
  const pushBoldRuns = (text: string): void => {
    const re = /\*\*([^*\n]+(?:\*[^*\n]+)*)\*\*/g;
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m.index > last) pushItalicRuns(text.slice(last, m.index), false);
      pushItalicRuns(m[1], true);
      last = m.index + m[0].length;
    }
    if (last < text.length) pushItalicRuns(text.slice(last), false);
  };
  // Triple markers first, so ***both*** is one bold-italic run rather than a
  // stray star on each side of a bold one.
  const re3 = /\*\*\*([^*\n]+)\*\*\*/g;
  let last = 0;
  for (let m = re3.exec(line); m; m = re3.exec(line)) {
    if (m.index > last) pushBoldRuns(line.slice(last, m.index));
    out.push({ text: m[1], bold: true, italic: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) pushBoldRuns(line.slice(last));
  return out.filter((r) => r.text !== '');
}

/** Parse a stored narrative into blocks. Blank lines separate; lines stand alone. */
export function parseRichText(text: string | null | undefined): RichBlock[] {
  const blocks: RichBlock[] = [];
  if (text == null) return blocks;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let list: { ordered: boolean; items: RichInline[][] } | null = null;
  const flushList = (): void => {
    if (list) blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      flushList();
      continue;
    }
    const h3 = /^###\s+(.*)$/.exec(line);
    const h2 = h3 ? null : /^##\s+(.*)$/.exec(line);
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (h3 || h2) {
      flushList();
      blocks.push({
        kind: 'heading',
        level: h3 ? 3 : 2,
        inlines: parseInlines((h3 ?? h2)![1]),
      });
    } else if (bullet || numbered) {
      const ordered = numbered != null;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(parseInlines((bullet ?? numbered)![1]));
    } else {
      flushList();
      blocks.push({ kind: 'paragraph', inlines: parseInlines(line) });
    }
  }
  flushList();
  return blocks;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One line's inlines as escaped HTML with strong and em marks. */
export function renderInlinesHtml(inlines: RichInline[]): string {
  return inlines
    .map((r) => {
      let html = escapeHtml(r.text);
      if (r.italic) html = `<em>${html}</em>`;
      if (r.bold) html = `<strong>${html}</strong>`;
      return html;
    })
    .join('');
}

/**
 * A stored narrative as safe HTML: paragraphs, h4/h5 (sitting under the page's
 * own h2/h3 hierarchy), ul/ol and strong/em. All text is escaped; the input is
 * never treated as HTML.
 */
export function renderRichHtml(text: string | null | undefined): string {
  return parseRichText(text)
    .map((b) => {
      if (b.kind === 'heading') {
        const tag = b.level === 2 ? 'h4' : 'h5';
        return `<${tag}>${renderInlinesHtml(b.inlines)}</${tag}>`;
      }
      if (b.kind === 'list') {
        const tag = b.ordered ? 'ol' : 'ul';
        const items = b.items.map((i) => `<li>${renderInlinesHtml(i)}</li>`).join('');
        return `<${tag}>${items}</${tag}>`;
      }
      return `<p>${renderInlinesHtml(b.inlines)}</p>`;
    })
    .join('');
}

/** The plain text of a narrative, marks dropped (for digests and previews). */
export function richTextToPlain(text: string | null | undefined): string {
  return parseRichText(text)
    .map((b) => {
      if (b.kind === 'list') {
        return b.items.map((i) => i.map((r) => r.text).join('')).join('\n');
      }
      return b.inlines.map((r) => r.text).join('');
    })
    .join('\n');
}

/**
 * Normalise a submitted narrative for storage: consistent newlines, control
 * characters (other than newlines) dropped, trailing whitespace trimmed. The
 * content itself stays Markdown text; there is no HTML to sanitise because
 * none is ever stored or rendered unescaped.
 */
export function normaliseRichText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
