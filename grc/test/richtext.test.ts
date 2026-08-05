/**
 * The narrative rich-text subset (richtext.ts): parsing, the safe HTML
 * rendering every screen uses, the plain-text projection and the storage
 * normalisation. The module is import-free, so node strips types and runs it
 * directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRichText,
  parseInlines,
  renderRichHtml,
  renderInlinesHtml,
  richTextToPlain,
  normaliseRichText,
} from '../../src/lib/grc/richtext.ts';

test('blocks: headings, paragraphs and lists, with blank lines as separators', () => {
  const blocks = parseRichText('## Head\n### Sub\nplain line\n\n- a\n- b\n1. one\n2) two');
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ['heading', 'heading', 'paragraph', 'list', 'list'],
  );
  assert.equal(blocks[0].kind === 'heading' && blocks[0].level, 2);
  assert.equal(blocks[1].kind === 'heading' && blocks[1].level, 3);
  const bullets = blocks[3];
  const numbered = blocks[4];
  assert.ok(bullets.kind === 'list' && !bullets.ordered && bullets.items.length === 2);
  assert.ok(numbered.kind === 'list' && numbered.ordered && numbered.items.length === 2);
});

test('inline marks: bold, italic, both, and unbalanced markers stay literal', () => {
  assert.deepEqual(parseInlines('**b** and *i*'), [
    { text: 'b', bold: true, italic: false },
    { text: ' and ', bold: false, italic: false },
    { text: 'i', bold: false, italic: true },
  ]);
  assert.deepEqual(parseInlines('***both***'), [{ text: 'both', bold: true, italic: true }]);
  // An unbalanced marker is content, not formatting.
  assert.deepEqual(parseInlines('a * b'), [{ text: 'a * b', bold: false, italic: false }]);
});

test('HTML rendering escapes content and never interprets stored text as HTML', () => {
  const html = renderRichHtml('**x** and <script>alert(1)</script>');
  assert.ok(html.includes('<strong>x</strong>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.equal(renderRichHtml('## H\n- i'), '<h4>H</h4><ul><li>i</li></ul>');
  assert.equal(renderInlinesHtml(parseInlines('*em* & "q"')), '<em>em</em> &amp; &quot;q&quot;');
});

test('the plain projection drops marks and markers', () => {
  assert.equal(richTextToPlain('## H\n**b** t\n- i1\n1. n1'), 'H\nb t\ni1\nn1');
});

test('normalisation: newlines, control characters and runs of blank lines', () => {
  assert.equal(normaliseRichText('a\r\nb\u0008c   \n\n\n\nd  '), 'a\nbc\n\nd');
});
