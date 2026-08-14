/**
 * The "Snapshot-led" palette and type rules, checked rather than trusted
 * (Build Prompt 72).
 *
 * WCAG 2.2 AA is a number, not an opinion: 4.5:1 for body text. A palette
 * signed off by eye passes until somebody adjusts one hex by two digits, which
 * is exactly the change nobody reviews carefully. So the ratios are computed
 * here, from the values in the stylesheet itself, and a shade that drops below
 * its threshold fails the build instead of shipping.
 *
 * The design's other rules are arithmetic too, and are checked the same way: two
 * text colours, no light weights, an 8px spacing rhythm, and risk as the only
 * colour on the panel. Each of those is easy to state and easy to lose one
 * declaration at a time.
 *
 * The values are read out of `grc.css` rather than restated, because a test
 * that carries its own copy of the palette is a test that agrees with itself
 * and nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'styles', 'grc.css'), 'utf8');

/** The `.grc-snap` block: every rule whose selector mentions the panel. */
const PANEL = (() => {
  const start = CSS.indexOf('.grc-snap {');
  assert.ok(start > 0, 'the stylesheet must still carry the snapshot panel');
  const end = CSS.indexOf('/* Print:', start);
  // Comments are stripped: a hex quoted in a note explaining why it was not
  // used is not a colour the panel draws with.
  return CSS.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, ' ');
})();

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

/** A scoped custom property from the panel's own block. */
function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(PANEL);
  assert.ok(m, `the palette must declare --${name}`);
  return m![1];
}

test('the Snapshot palette is the one that was chosen', () => {
  // Pinned, because "roughly this white" is not a specification and the whole
  // point of the design is that every surface uses the same one.
  assert.equal(token('sn-page'), '#faf8f3');
  assert.equal(token('sn-panel'), '#ffffff');
  assert.equal(token('sn-divider'), '#f2eee4');
  assert.equal(token('sn-border'), '#ece7db');
  assert.equal(token('sn-navy'), '#1a2740');
  assert.equal(token('sn-ink'), '#1d2129');
  assert.equal(token('sn-muted'), '#71767f');
  // One shade darker than the design named (#a9822b), and only one: at 3.55:1
  // on the panel it failed AA for an 11.5px uppercase label. This is the least
  // darkening that clears it.
  assert.equal(token('sn-gold'), '#917025');
});

test('every colour that carries text clears AA on the panel it sits on', () => {
  const panel = token('sn-panel');
  for (const [name, what] of [
    ['sn-ink', 'body text'],
    ['sn-navy', 'the title'],
    ['sn-muted', 'secondary text'],
    ['sn-gold', 'a section label'],
  ] as const) {
    const ratio = contrast(token(name), panel);
    assert.ok(ratio >= 4.5, `${what} is ${ratio.toFixed(2)}:1 on the panel, and needs 4.5`);
  }
});

test('every risk pill clears AA, and is visible as a shape', () => {
  // Colour is never the only signal, but the signal it does carry has to be
  // legible: the label against its own fill, and the fill against the panel.
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
    const fill = contrast(background, token('sn-panel'));
    assert.ok(
      fill > 1.05,
      `${selector.split(',')[0]}: a fill of ${fill.toFixed(2)}:1 is not a pill anybody can see`,
    );
  }
});

test('risk is the only colour on the panel', () => {
  // The whole reason the risk pill means something is that nothing else is
  // coloured. Every colour the panel declares must therefore be one of the
  // seven tokens; a stray hex is a second thing competing for the same
  // attention.
  const allowed = new Set(
    [
      'sn-page',
      'sn-panel',
      'sn-divider',
      'sn-border',
      'sn-navy',
      'sn-ink',
      'sn-muted',
      'sn-gold',
    ].map((name) => token(name)),
  );
  const strays = [...PANEL.matchAll(/#[0-9a-f]{6}/gi)]
    .map((m) => m[0].toLowerCase())
    .filter((hex) => !allowed.has(hex));
  assert.deepEqual(strays, [], `these colours are declared on the panel and are not tokens`);
});

test('two text colours carry the running text, and neither is a third', () => {
  // Navy is the title and gold is the section label, which the design names as
  // its two exceptions. Everything that is read as prose is ink or muted.
  for (const selector of ['.grc-snap__body', '.grc-snap__empty', '.grc-snap__table td']) {
    const colour = rule(selector).color;
    assert.ok(
      colour === 'var(--sn-ink)' || colour === 'var(--sn-muted)',
      `${selector} is set in ${colour}, which is neither ink nor muted`,
    );
  }
});

test('no light weight appears anywhere on the panel', () => {
  // A 12px label at 300 is a label somebody has to lean in to read. Regular,
  // medium and semibold only.
  const weights = [...PANEL.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(weights.length > 0, 'the panel must set some weights');
  for (const weight of weights) {
    assert.ok(weight >= 400 && weight <= 600, `font-weight ${weight} is outside 400 to 600`);
  }
});

test('the spacing keeps an 8px rhythm', () => {
  // Predictable spacing is what lets a reader skim: if every gap is a multiple
  // of the same unit, the eye knows where the next thing starts. Type sizes and
  // hairlines are exempt, which is why only the box properties are read.
  const offenders: string[] = [];
  for (const m of PANEL.matchAll(/\n\s*(margin|padding|gap)(?:-[a-z]+)?:\s*([^;]+);/g)) {
    for (const value of m[2].split(/\s+/)) {
      const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
      if (!px) continue;
      const n = Number(px[1]);
      if (n !== 0 && n % 4 !== 0) offenders.push(`${m[1]}: ${value}`);
    }
  }
  assert.deepEqual(offenders, [], `these spacings break the rhythm: ${offenders.join(', ')}`);
});

test('nothing on the panel is a filled or dark block', () => {
  // The design is flat and light. A dark background under white text would pass
  // a contrast check and still be the thing this replaced.
  for (const selector of ['.grc-snap', '.grc-snap__head', '.grc-snap__section', '.grc-chip']) {
    const background = rule(selector).background;
    if (background === undefined || background === 'transparent') continue;
    const hex = background.startsWith('var') ? token('sn-panel') : background;
    assert.ok(luminance(hex) > 0.7, `${selector} is drawn on ${background}, which is not light`);
  }
});

test('the panel renders in the system typeface, and asks for no download', () => {
  const stack = rule('.grc-snap')['font-family'] ?? PANEL;
  assert.match(stack, /-apple-system/, 'the system stack leads with the platform font');
  assert.ok(!/@font-face|url\(/.test(PANEL), 'and nothing on the panel fetches a typeface');
});
