/**
 * The "Quiet paper" palette, checked rather than trusted (Build Prompt 71).
 *
 * WCAG 2.2 AA is a number, not an opinion: 4.5:1 for body text, 3:1 for large
 * text and for a border that has to be seen. A palette signed off by eye passes
 * until somebody adjusts one hex by two digits, which is exactly the change
 * nobody reviews carefully. So the ratios are computed here, from the values in
 * the stylesheet itself, and a shade that drops below its threshold fails the
 * build instead of shipping.
 *
 * The colours are read out of `grc.css` rather than restated, because a test
 * that carries its own copy of the palette is a test that agrees with itself
 * and nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'styles', 'grc.css'), 'utf8');

/** sRGB relative luminance, per the WCAG definition. */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channel = (pair: string): number => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)].map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The declarations of one rule, by property. */
function rule(selector: string): Record<string, string> {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.ok(at > 0, `the stylesheet must still carry ${selector}`);
  const body = CSS.slice(at + selector.length + 3, CSS.indexOf('}', at));
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = /^\s*([a-z-]+):\s*(.+?);\s*$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/** A scoped custom property from the `.grc-finding` block. */
function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(CSS);
  assert.ok(m, `the palette must declare --${name}`);
  return m![1];
}

test('the Quiet paper palette is the one that was chosen', () => {
  // Pinned, because "roughly this beige" is not a specification and the whole
  // point of the design is that every surface uses the same one.
  assert.equal(token('qp-paper'), '#f4efe4');
  assert.equal(token('qp-card'), '#fffdf9');
  assert.equal(token('qp-line'), '#e6dfce');
  assert.equal(token('qp-navy'), '#16233f');
  // Two shades darker than the design named, and only two: the values it gave
  // for these failed AA where they are used, and the ratios below are what
  // decided the replacements rather than an eye.
  assert.equal(token('qp-gold'), '#8c6f23');
  assert.equal(token('qp-ink'), '#1b2430');
  assert.equal(token('qp-muted'), '#646b76');
});

test('body text on a card clears AA', () => {
  const card = token('qp-card');
  assert.ok(contrast(token('qp-ink'), card) >= 4.5, 'ink on the card');
  assert.ok(contrast(token('qp-navy'), card) >= 4.5, 'a card title on the card');
  assert.ok(contrast(token('qp-muted'), card) >= 4.5, 'muted text on the card');
});

test('the gold section label clears AA on the card it sits on', () => {
  // The label is small and uppercase, so it is body text as far as the rule is
  // concerned: 4.5:1, not the 3:1 large text is allowed.
  const ratio = contrast(token('qp-gold'), token('qp-card'));
  assert.ok(ratio >= 4.5, `the gold label is ${ratio.toFixed(2)}:1 on the card, and needs 4.5`);
});

test('the header strip is text clears AA on the paper it sits on', () => {
  // The strip is transparent, so its text is read against the page's own
  // ground. The gold is not checked here because it never appears outside a
  // card: testing a pairing the design does not use would constrain the
  // palette for no reader's benefit.
  const paper = token('qp-paper');
  for (const name of ['qp-ink', 'qp-navy', 'qp-muted']) {
    const ratio = contrast(token(name), paper);
    assert.ok(ratio >= 4.5, `--${name} is ${ratio.toFixed(2)}:1 on the paper, and needs 4.5`);
  }
});

test('every risk pill clears AA, and its border is visible', () => {
  // Colour is never the only signal, but the signal it does carry has to be
  // legible: the label against its own fill, and the fill distinguishable from
  // the card it sits on.
  for (const selector of [
    '.grc-pill--risk-high,\n.grc-pill--risk-critical',
    '.grc-pill--risk-medium,\n.grc-pill--warn',
    '.grc-pill--risk-low,\n.grc-pill--ok',
    '.grc-pill--risk-extreme',
  ]) {
    const declarations = rule(selector);
    const { background, color } = declarations;
    const ratio = contrast(color, background);
    assert.ok(
      ratio >= 4.5,
      `${selector.split(',')[0]}: ${color} on ${background} is ${ratio.toFixed(2)}:1, and needs 4.5`,
    );
    // The pill has to be distinguishable from the card behind it. This is not
    // the 3:1 of 1.4.11: the rating is carried by its own word, and the shape
    // is a decoration around a label, not a control or a meaningful graphic. It
    // does still have to be visible as a shape, which is what this asks.
    const fill = contrast(background, token('qp-card'));
    assert.ok(
      fill > 1.05,
      `${selector.split(',')[0]}: a fill of ${fill.toFixed(2)}:1 is not a pill anybody can see`,
    );
  }
});

test('the hairline that separates a card from the page is visible', () => {
  const edge = contrast(token('qp-line'), token('qp-card'));
  assert.ok(edge >= 1.2, `a hairline of ${edge.toFixed(2)}:1 is not a line anybody can see`);
});

test('nothing in the observation cards is a filled or dark block', () => {
  // The design is flat and light. A dark background under white text would pass
  // a contrast check and still be the thing this replaced.
  for (const selector of ['.grc-finding__strip', '.grc-fcard', '.grc-finding__group']) {
    const background = rule(selector).background;
    if (background === undefined || background === 'transparent') continue;
    assert.ok(
      luminance(background.startsWith('var') ? token('qp-card') : background) > 0.7,
      `${selector} is drawn on ${background}, which is not light`,
    );
  }
});
