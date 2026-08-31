/**
 * Build Prompt 31: the design sweep, held in place.
 *
 * A design pass that is not tested is a design pass that lasts until the next
 * hurried commit. Every rule the sweep introduced is asserted here against the
 * source, so the rule is enforced by the suite rather than by whoever reviews
 * the pull request.
 *
 * CONTRAST IS MEASURED, NOT INTENDED. The ratios below are computed from the
 * token values in src/styles/tokens.css with the WCAG relative luminance
 * formula, so a token edited to a prettier value that fails AA fails here
 * instead of failing a user.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import {
  LEADERBOARD_HEADERS,
  leaderboardColumns,
} from '../../src/lib/cms/analytics/leaderboard.ts';
import { SERIES_TOKENS, lineChart } from '../../src/lib/cms/charts/svg.ts';
import { formatDuration } from '../../src/lib/cms/analytics/stats.ts';
import { join } from 'node:path';

const TOKENS = 'src/styles/tokens.css';

function walk(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, extension));
    else if (path.endsWith(extension)) out.push(path);
  }
  return out;
}

/** Every file this sweep is responsible for. */
const CMS_SOURCE = [
  ...walk('src/components/cms', '.astro'),
  ...walk('src/pages/cms', '.astro'),
  ...walk('src/lib/cms', '.ts'),
  'src/layouts/CmsLayout.astro',
  'src/layouts/CmsAuthLayout.astro',
  'src/layouts/CmsPortalLayout.astro',
];

const CMS_PAGES = walk('src/pages/cms', '.astro');

// ---------------------------------------------------------------------------
// Colour arithmetic, so the contrast table is a measurement
// ---------------------------------------------------------------------------

const tokenSource = readFileSync(TOKENS, 'utf8');

/** A token's literal value, following one level of `var()` indirection. */
function token(name: string): string {
  const direct = new RegExp(`--color-${name}:\\s*([^;]+);`).exec(tokenSource);
  assert.ok(direct, `--color-${name} is not defined in ${TOKENS}`);
  const value = direct[1]!.trim();
  const indirect = /^var\(--color-([a-z0-9-]+)\)$/.exec(value);
  return indirect ? token(indirect[1]!) : value;
}

function luminance(hex: string): number {
  const clean = hex.replace('#', '');
  const parts = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  const linear = parts.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Section 0: the stack held
// ---------------------------------------------------------------------------

test('no hex literal exists outside the token file', () => {
  // Including Tailwind arbitrary values of the form `[#`, which are the way a
  // colour usually sneaks back in: they look like a class rather than a colour.
  const offenders: string[] = [];
  for (const path of CMS_SOURCE) {
    const source = readFileSync(path, 'utf8');
    for (const [index, line] of source.split('\n').entries()) {
      if (/#[0-9a-fA-F]{3,8}\b/.test(line) && !/^\s*\*/.test(line) && !line.includes('//')) {
        offenders.push(`${path}:${index + 1} ${line.trim()}`);
      }
      if (line.includes('[#')) offenders.push(`${path}:${index + 1} arbitrary hex`);
    }
  }
  assert.deepEqual(offenders, [], `every colour is a token:\n${offenders.join('\n')}`);
});

test('every CMS colour token used by a class is defined, and is namespaced', () => {
  const used = new Set<string>();
  for (const path of CMS_SOURCE) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(
      /\b(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|accent|shadow)-(cms-[a-z0-9-]+)/g,
    )) {
      used.add(match[1]!);
    }
  }
  assert.ok(used.size > 20, 'the scan found the classes');
  const missing: string[] = [];
  for (const name of used) {
    // A class may end in a scale suffix the token does not carry, and shadow
    // and radius live under their own prefixes.
    if (name.startsWith('cms-')) {
      const colour = tokenSource.includes(`--color-${name}:`);
      const shadow = tokenSource.includes(`--shadow-${name}:`);
      const text = tokenSource.includes(`--text-${name}:`);
      if (!colour && !shadow && !text) missing.push(name);
    }
  }
  assert.deepEqual(missing, [], `undefined tokens referenced by a class: ${missing.join(', ')}`);
});

test('no CMS token collides with the three other products', () => {
  // Every token this product adds is `cms-` prefixed. The @theme block is
  // emitted on :root and is therefore global to the marketing site,
  // Engineering Rhythm and the GRC platform at once.
  // Bounded at both ends: the shared type scale follows the CMS block in the
  // same @theme, and swallowing it would report every marketing token as a
  // CMS one.
  const block = tokenSource.slice(
    tokenSource.indexOf('CMS product tokens'),
    tokenSource.indexOf('Type families'),
  );
  const declared = [...block.matchAll(/^\s*--(color|text|shadow|radius|animate)-([a-z0-9-]+):/gm)];
  assert.ok(declared.length > 30, 'the CMS block was found');
  const unnamespaced = declared
    .map((m) => m[2]!)
    .filter((name) => !name.startsWith('cms-') && !name.startsWith('cms'));
  assert.deepEqual(unnamespaced, [], `unnamespaced CMS tokens: ${unnamespaced.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Section 2: the palette
// ---------------------------------------------------------------------------

test('measured contrast: every pair meets its WCAG 2.2 threshold', () => {
  const canvas = token('cms-canvas');
  const surface = token('cms-surface');
  const sunken = token('cms-sunken');
  const navy = token('cms-navy');

  // [what it is, foreground, background, minimum]
  const pairs: [string, string, string, number][] = [
    ['body text on canvas', token('cms-ink'), canvas, 4.5],
    ['body text on surface', token('cms-ink'), surface, 4.5],
    ['body text on a table head', token('cms-ink'), sunken, 4.5],
    ['secondary text on canvas', token('cms-muted'), canvas, 4.5],
    ['secondary text on surface', token('cms-muted'), surface, 4.5],
    ['control boundary on canvas', token('cms-border'), canvas, 3],
    ['control boundary on surface', token('cms-border'), surface, 3],
    ['primary action label', '#ffffff', token('cms-royal'), 4.5],
    ['primary action as text', token('cms-royal'), canvas, 4.5],
    ['primary action as text on surface', token('cms-royal'), surface, 4.5],
    ['selected row text', token('cms-royal'), token('cms-royal-tint'), 4.5],
    ['gold emphasis on light', token('cms-gold-ink'), canvas, 4.5],
    ['gold on the rail', token('cms-gold'), navy, 4.5],
    ['rail label', token('cms-rail-text'), navy, 4.5],
    ['rail section heading', token('cms-rail-muted'), navy, 4.5],
    ['rail active label', '#ffffff', navy, 4.5],
    ['focus ring on canvas', token('focus'), canvas, 3],
    ['focus ring on surface', token('focus'), surface, 3],
    ['focus ring on the rail', token('focus'), navy, 3],
  ];

  for (const role of ['positive', 'caution', 'negative', 'info', 'neutral']) {
    pairs.push(
      [`${role} status text on its tint`, token(`cms-${role}`), token(`cms-${role}-tint`), 4.5],
      [`${role} status text on surface`, token(`cms-${role}`), surface, 4.5],
      [`${role} status edge on surface`, token(`cms-${role}-border`), surface, 3],
    );
  }
  // SEVEN, BECAUSE THE PURCHASE ORDER TEMPLATE ALLOWS SEVEN APPROVAL LEVELS and
  // the bar chart takes one token per function. The loop follows the palette
  // rather than a number written twice, so an eighth token cannot be added
  // without a measurement.
  for (let n = 1; n <= SERIES_TOKENS.length; n++) {
    pairs.push([`chart series ${n} on surface`, token(`cms-series-${n}`), surface, 4.5]);
    pairs.push([`chart series ${n} on canvas`, token(`cms-series-${n}`), canvas, 4.5]);
  }

  const table: string[] = [];
  const failures: string[] = [];
  for (const [what, fg, bg, minimum] of pairs) {
    const ratio = contrast(fg, bg);
    table.push(`  ${what.padEnd(38)} ${fg} on ${bg}  ${ratio.toFixed(2)}:1 (needs ${minimum})`);
    if (ratio < minimum) failures.push(`${what}: ${ratio}:1, needs ${minimum}:1`);
  }
  console.log(`[contrast] measured, not intended\n${table.join('\n')}`);
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('the canvas and the surface are separated by tone, not by a border', () => {
  const step = contrast(token('cms-surface'), token('cms-canvas'));
  // Enough to read as a change of plane, far too little to read as a line.
  assert.ok(step > 1.02, `the surface is indistinguishable from the canvas (${step}:1)`);
  assert.ok(step < 1.3, `the surface is loud enough to be doing a border's job (${step}:1)`);
});

test('the workspace is light: no content-area surface sits on a dark field', () => {
  // The rail and the sign-in brand panel are the two anchored dark columns and
  // are allowed. Anything else painting navy is a dark field in the workspace.
  // The shell chrome is allowed to be dark: the rail, the mobile drawer that
  // is the same rail, the top bar and the sign-in brand panel. So is a modal
  // scrim, which is the dimming behind an overlay and not a surface anybody
  // reads. What must never be dark is a content surface.
  const chrome = new Set([
    'src/layouts/CmsLayout.astro',
    'src/layouts/CmsAuthLayout.astro',
    'src/layouts/CmsPortalLayout.astro',
    'src/components/cms/CmsSidebar.astro',
    'src/components/cms/CmsTopBar.astro',
    'src/components/cms/CmsWordmark.astro',
    'src/components/cms/CmsDrawer.astro',
    'src/components/cms/CmsAvatar.astro',
    'src/components/cms/CmsIconButton.astro',
    // The design reference exists to show every primitive in every state,
    // which includes the two tones that only ever appear on the rail. It is
    // the one page that renders chrome out of its context, on purpose, and it
    // is behind an administration permission.
    'src/pages/cms/app/administration/components.astro',
  ]);
  const offenders: string[] = [];
  for (const path of CMS_SOURCE) {
    if (chrome.has(path)) continue;
    const source = readFileSync(path, 'utf8');
    for (const [index, line] of source.split('\n').entries()) {
      // `backdrop:bg-cms-navy/45` is a scrim behind a dialog, not a field.
      if (/backdrop:/.test(line)) continue;
      if (/\bbg-cms-navy(-soft|-deep)?\b/.test(line)) {
        offenders.push(`${path}:${index + 1} ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `dark fields in the workspace:\n${offenders.join('\n')}`);
});

test('only the navigation drawer asks for a dark tone', () => {
  // THE BLIND SPOT THE INVISIBLE FORM CAME THROUGH.
  //
  // The test above allowlists CmsDrawer as chrome, because the dark navy is
  // genuinely written there and the mobile menu genuinely needs it. So it never
  // asked the question that mattered: WHO CHOOSES that tone. `tone` defaulted
  // to `navigation`, and two screens — "Add a provider" and "Add a connection"
  // — simply omitted the prop. Light-canvas form fields rendered on navy and
  // every label and every helper became invisible; what survived was the red
  // required asterisks floating above white boxes with nothing to say what they
  // were. Nineteen sibling drawers passed tone="form" and were fine, which is
  // exactly what made it invisible in review.
  //
  // The default is now `form`, so a forgotten prop yields a legible screen, and
  // the dark tone must be asked for by name. This asserts that only the shell's
  // own navigation drawer asks.
  const drawer = readFileSync('src/components/cms/CmsDrawer.astro', 'utf8');
  assert.match(
    drawer,
    /tone = 'form'/,
    'the drawer must default to the light form tone, so forgetting the prop is safe',
  );

  const dark: string[] = [];
  for (const path of CMS_SOURCE.concat(CMS_PAGES)) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/<CmsDrawer\b[^>]*>/g)) {
      if (/tone="navigation"/.test(match[0])) dark.push(path);
    }
  }
  assert.deepEqual(
    [...new Set(dark)],
    ['src/layouts/CmsLayout.astro'],
    'only the shell navigation drawer may use the dark tone',
  );
});

test('a short form uses the one modal, and there is only one', () => {
  // ONE MODAL, NOT A SECOND IMPLEMENTATION. A drawer suits a long list beside
  // the page you came from; these are short forms with a single outcome.
  const overlays = CMS_SOURCE.filter((path) =>
    /Cms(Modal|Dialog|Sheet|Popover)\.astro$/.test(path),
  );
  assert.deepEqual(overlays, ['src/components/cms/CmsModal.astro'], 'exactly one modal exists');

  const modal = readFileSync('src/components/cms/CmsModal.astro', 'utf8');
  // The surface is not negotiable: there is no tone prop to get wrong. Checked
  // against the Props interface rather than the whole file, because the doc
  // comment explains at length why the prop is absent.
  const props = modal.slice(modal.indexOf('interface Props'), modal.indexOf('} = Astro.props'));
  assert.ok(!/\btone\b/.test(props), 'the modal offers no tone to choose');
  assert.match(modal, /bg-cms-surface text-cms-ink/, 'light surface, ink text');
  // A full-screen sheet on a phone, a centred box from sm up, one elevation.
  assert.match(modal, /h-dvh max-h-none w-screen/, 'it is a sheet at a mobile viewport');
  assert.match(modal, /sm:w-\[min\(32rem,calc\(100vw-2rem\)\)\]/, 'and a box from sm up');
  assert.equal((modal.match(/shadow-cms-/g) ?? []).length, 1, 'one elevation level, used once');
  assert.match(modal, /overflow-y-auto/, 'the body scrolls inside the modal');

  // Both reported screens use it, and neither uses a drawer any more.
  for (const path of [
    'src/pages/cms/app/administration/ai.astro',
    'src/pages/cms/app/administration/channels.astro',
  ]) {
    const source = readFileSync(path, 'utf8');
    assert.match(source, /<CmsModal/, `${path} does not use the modal`);
    assert.ok(!/<CmsDrawer/.test(source), `${path} still uses a drawer`);
  }
});

test('the modal returns focus, locks the page, and confirms a dirty discard', () => {
  const script = readFileSync('src/components/cms/CmsOverlayScript.astro', 'utf8');
  // Written once for every dialog in the shell rather than per modal.
  assert.match(script, /openedBy\.set\(dialog, opener\)/, 'the opener is remembered');
  assert.match(
    script,
    /opener\.isConnected.*\n?.*opener\.focus\(\)|opener\.isConnected\) opener\.focus\(\)/,
  );
  assert.match(script, /cms-overlay-open/, 'the page behind is locked');
  assert.match(script, /cmsConfirmDirty/, 'a dirty form confirms before it is discarded');
  assert.match(script, /'cancel'/, 'Escape is intercepted so the discard can be stopped');

  const css = readFileSync('src/styles/global.css', 'utf8');
  assert.match(css, /html\.cms-overlay-open\s*\{\s*overflow:\s*hidden/);
  // Reserving the gutter at all times, so locking the scroll does not shift
  // the layout sideways as the modal opens.
  assert.match(css, /scrollbar-gutter:\s*stable/);
});

test('the two forms carry business-language labels and exactly one helper', () => {
  for (const [path, field] of [
    ['src/pages/cms/app/administration/ai.astro', 'ai-secret'],
    ['src/pages/cms/app/administration/channels.astro', 'ch-secret'],
  ] as const) {
    const source = readFileSync(path, 'utf8');
    const form = source.slice(source.indexOf('<CmsModal'), source.indexOf('</CmsModal>'));

    // No label repeats a column name.
    for (const match of form.matchAll(/label="([^"]+)"/g)) {
      const label = match[1]!;
      assert.ok(!/_/.test(label), `${path}: "${label}" reads like a column name`);
      assert.ok(
        !/^(Worker secret name|Number or mailbox)$/.test(label),
        `${path}: "${label}" is the old technical wording`,
      );
    }

    // EXACTLY ONE HELPER LINE, on the secret name, because that field is
    // genuinely counter-intuitive: it asks for the NAME of a secret and not the
    // key, and somebody who pastes the key stores a credential in the database.
    const hints = [...form.matchAll(/hint="([^"]+)"/g)];
    assert.equal(hints.length, 1, `${path} carries ${hints.length} helpers, expected exactly one`);
    const secret = form.slice(form.indexOf(field));
    assert.match(secret.slice(0, 400), /hint="/, 'the helper is on the secret name field');
    assert.match(hints[0]![1]!, /not the key itself/, 'it says what the field is not');
    assert.match(hints[0]![1]!, /For example [A-Z_]+/, 'and gives an example of a name');
  }
});

test('exactly one elevation level exists, and only overlays use it', () => {
  const shadows = [...tokenSource.matchAll(/^\s*--shadow-(cms-[a-z-]+):/gm)].map((m) => m[1]!);
  assert.deepEqual(shadows, ['cms-overlay'], `CMS shadow tokens: ${shadows.join(', ')}`);

  // A card does not float. Only something that genuinely floats over the page
  // and can be dismissed may carry the one shadow.
  const users = CMS_SOURCE.filter((p) => readFileSync(p, 'utf8').includes('shadow-cms-overlay'));
  const floats =
    // The period control's panel is a genuine overlay: it floats over the page,
    // is dismissible, and is the one thing on an analytics page that does.
    /Drawer|Modal|Dropdown|Tooltip|Toast|Definition|Overlay|TopBar|Layout|Search|Filter|Audit|Period/;
  const wrong = users.filter((p) => !floats.test(p));
  assert.deepEqual(wrong, [], `these are not overlays and must not float: ${wrong.join(', ')}`);
  console.log(`[elevation] one token, used by: ${users.map((p) => p.split('/').pop()).join(', ')}`);
});

// ---------------------------------------------------------------------------
// Section 3: semantic colour means one thing
// ---------------------------------------------------------------------------

test('a semantic colour is never used as a chart series', () => {
  // A line on a chart is not good or bad. Borrowing the colour that means
  // "breached" for a series makes the reader believe the shape is a verdict.
  const charts = ['src/lib/cms/charts/svg.ts', ...CMS_PAGES];
  const offenders: string[] = [];
  for (const path of charts) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/token:\s*'([a-z0-9-]+)'/g)) {
      if (!match[1]!.startsWith('cms-series-')) offenders.push(`${path}: ${match[1]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `semantic or brand colour used as a series:\n${offenders.join('\n')}`,
  );
});

test('status is never carried by colour alone', () => {
  // The badge is the only status pill, its label is a required prop, and it
  // draws an icon beside it. There is deliberately no way to render it as a
  // bare coloured dot, which is what this asserts rather than trusting.
  const badge = readFileSync('src/components/cms/CmsBadge.astro', 'utf8');
  assert.match(badge, /label:\s*string;/, 'the label is required, not optional');
  assert.match(badge, /const glyph = icon \?\? defaultIcon\[tone\]/, 'every tone has an icon');
  for (const tone of ['neutral', 'success', 'warning', 'danger', 'info']) {
    assert.ok(
      new RegExp(`${tone}: 'status`).test(badge) || badge.includes(`${tone}: 'bg-cms-`),
      `${tone} has both a colour and a glyph`,
    );
  }
  // And no page renders a status as a bare coloured square or dot.
  const offenders: string[] = [];
  for (const path of CMS_PAGES) {
    const source = readFileSync(path, 'utf8');
    for (const [index, line] of source.split('\n').entries()) {
      if (/rounded-full/.test(line) && /bg-cms-(positive|caution|negative)\b/.test(line)) {
        offenders.push(`${path}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `bare status dots:\n${offenders.join('\n')}`);
});

test('one vocabulary for SLA states, with no synonym in user-visible text', () => {
  // The banned words in anything a person reads. Internal identifiers such as
  // `overdueFollowUps` keep the word: renaming a repository field changes what
  // no user sees and this sweep does not touch query shapes.
  const banned = /\b(overdue|late|delayed)\b/i;
  const offenders: string[] = [];
  for (const path of [...CMS_PAGES, ...walk('src/components/cms', '.astro')]) {
    const source = readFileSync(path, 'utf8');
    for (const [index, line] of source.split('\n').entries()) {
      if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
      for (const match of line.matchAll(/(?:label|title|placeholder|description)="([^"]*)"/g)) {
        if (banned.test(match[1]!)) offenders.push(`${path}:${index + 1} ${match[1]}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `banned SLA synonyms in user-visible text:\n${offenders.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// Section 4: the explanations are gone
// ---------------------------------------------------------------------------

test('no page carries a static paragraph describing its own contents', () => {
  // The rule is crisp because the shape is crisp: a page header description
  // written as a literal string is prose about the page. A description built
  // from a template is the RECORD's context, which is data, and stays.
  const offenders: string[] = [];
  for (const path of CMS_PAGES) {
    const source = readFileSync(path, 'utf8');
    const header = source.indexOf('<CmsPageHeader');
    if (header < 0) continue;
    const tag = source.slice(header, source.indexOf('>', header) + 1);
    const literal = /\n\s*description="([^"]*)"/.exec(tag);
    if (literal) offenders.push(`${path}: ${literal[1]}`);
  }
  assert.deepEqual(offenders, [], `page descriptions still present:\n${offenders.join('\n')}`);
});

test('no user-facing text names a permission code, a query, a resolver or a scope', () => {
  // THE GREP IS THE TEST. A page that explains its own permission model is
  // telling a reader something they cannot act on, in vocabulary that belongs
  // to the people who built it. Comments are exempt: this is about what is
  // rendered, and the reasoning has to live somewhere.
  const offenders: string[] = [];
  // A PERMISSION CODE, NOT THE WORD. "You do not have permission to read the
  // audit trail" is plain English and is the honest thing to say to somebody
  // who was refused; `AUDIT.EVENTS.VIEW` is an internal identifier and is not.
  // The same distinction applies to the rest: the machinery, never the idea.
  const naming =
    /[A-Z]{3,}\.[A-Z_]+\.[A-Z_]+|\bresolver\b|\bsubrequest|round trip|\bSQL\b|\.sql\b|scope resolver|\bpermission code\b/;
  for (const path of CMS_SOURCE) {
    if (!path.endsWith('.astro')) continue;
    const source = readFileSync(path, 'utf8');
    // Everything before the closing frontmatter fence is code, not text; and a
    // line that is part of a block comment is reasoning, not a screen.
    const body = source.slice(source.indexOf('---', 3) + 3);
    let inComment = false;
    for (const [index, line] of body.split('\n').entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{/*') || trimmed.startsWith('/*')) inComment = true;
      if (inComment) {
        if (trimmed.includes('*/')) inComment = false;
        continue;
      }
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
      // A `permission` prop or variable is code; only rendered prose counts,
      // which is text inside quotes or between tags.
      const rendered = [...trimmed.matchAll(/"([^"]{12,})"|'([^']{12,})'|>([^<>{}]{12,})</g)].map(
        (m) => m[1] ?? m[2] ?? m[3] ?? '',
      );
      for (const text of rendered) {
        if (naming.test(text)) offenders.push(`${path}:${index + 1} ${text.slice(0, 90)}`);
      }
    }
  }
  console.log(`[verbosity] internals named in user-facing text: ${offenders.length}`);
  assert.deepEqual(offenders, [], `user-facing text naming internals:\n${offenders.join('\n')}`);
});

test('the accent appears once per view', () => {
  // THE ITEM THAT DIFFERS IS THE ITEM THAT IS REMEMBERED. Four highlights are
  // no highlights, so a page gets one. The rail's active marker is the
  // application's standing use of it and lives in the shell, not on a page.
  const pages = [
    'src/pages/cms/app/index.astro',
    'src/pages/cms/app/orders/sales.astro',
    'src/pages/cms/login.astro',
  ];
  const counts: string[] = [];
  for (const path of pages) {
    const source = readFileSync(path, 'utf8');
    const used = (source.match(/\bcms-gold\b/g) ?? []).length;
    counts.push(`  ${path.padEnd(40)} ${used}`);
    assert.ok(used <= 1, `${path} uses the accent ${used} times`);
  }
  console.log(`[accent] uses per page\n${counts.join('\n')}`);
  // And exactly once in the shell, where the current page is marked.
  const sidebar = readFileSync('src/components/cms/CmsSidebar.astro', 'utf8');
  assert.equal((sidebar.match(/bg-cms-gold/g) ?? []).length, 1);
});

test('a KPI definition is available on demand and is never body text', () => {
  const definition = readFileSync('src/components/cms/CmsDefinition.astro', 'utf8');
  // Native <details>: no JavaScript, in the tab order, announces its state.
  assert.match(definition, /<details/, 'the disclosure is native');
  assert.match(definition, /aria-label={`What \$\{label\} measures`}/, 'the control is named');
  assert.match(definition, /Population:/, 'the denominator is carried');
  assert.match(definition, /Dated by:/, 'the date basis is carried');

  // And the chart no longer prints its definition under the title.
  const chart = readFileSync('src/components/cms/CmsChart.astro', 'utf8');
  assert.ok(
    !/<p[^>]*>\{definition\}<\/p>/.test(chart),
    'the chart definition is no longer a paragraph',
  );
  assert.match(chart, /<CmsDefinition/, 'it is behind the disclosure instead');
});

test('every chart keeps its text alternative and its data table', () => {
  const chart = readFileSync('src/components/cms/CmsChart.astro', 'utf8');
  assert.match(chart, /<p class="sr-only">\{chart\.alt\}<\/p>/, 'the sentence survives');
  assert.match(chart, /chart\.table\.columns\.map/, 'the table survives');
  assert.match(chart, /chart\.table\.rows\.map/, 'with its rows');
  assert.match(chart, /<caption class="sr-only">\{title\}\. \{definition\}<\/caption>/);
});

test('every form field keeps a persistent label', () => {
  // Removing labels is not simplification, it is the placeholder-only pattern
  // that fails the moment somebody starts typing.
  for (const component of ['CmsInput', 'CmsSelect']) {
    const source = readFileSync(`src/components/cms/${component}.astro`, 'utf8');
    assert.match(source, /\n\s*label:\s*string;/, `${component} requires a label`);
    assert.match(source, /<label/, `${component} renders one`);
  }
  const offenders: string[] = [];
  for (const path of [...CMS_PAGES, ...walk('src/components/cms', '.astro')]) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/<Cms(Input|Select)\b([\s\S]*?)\/>/g)) {
      if (!/\blabel=/.test(match[2]!)) offenders.push(`${path}: a ${match[1]} with no label`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

// ---------------------------------------------------------------------------
// Section 5: everything drills
// ---------------------------------------------------------------------------

test('a figure with nothing behind it is never a link', () => {
  const figure = readFileSync('src/components/cms/CmsFigure.astro', 'utf8');
  assert.match(figure, /const absent = value === NOT_AVAILABLE/, 'absence is recognised');
  assert.match(figure, /const drillable = href !== undefined && href !== '' && !absent/);
  // The absent value renders as text, so a dead link cannot be produced.
  assert.match(figure, /absent \? 'text-cms-muted' : 'text-cms-ink'/);
});

test('a drillable figure is a real link with a focus ring', () => {
  for (const component of ['CmsFigure', 'CmsKpiCard']) {
    const source = readFileSync(`src/components/cms/${component}.astro`, 'utf8');
    assert.match(source, /<a\s+href=\{href\}/, `${component} renders an anchor, not a handler`);
    assert.match(
      source,
      /focus-visible:ring-2 focus-visible:ring-focus/,
      `${component} focus ring`,
    );
    assert.ok(
      /hover:underline/.test(source) || /:hover_\[data-figure\]\]:underline/.test(source),
      `${component} changes on hover`,
    );
    assert.match(source, /Open the records behind this figure/, `${component} says so to a reader`);
  }
});

test('every figure on Home carries a destination', () => {
  // Home is charts and two leaderboards now, and the leaderboards are one
  // component used twice, so the countable figures live there. The rule is
  // unchanged: a number nobody can open is a number nobody can check.
  //
  // Only the TEMPLATE is scanned. The frontmatter legitimately calls `count()`
  // to build a sentence, and a helper that formats a number is not a figure on
  // a screen; matching it would make the assertion about where code sits
  // rather than about what a reader can click.
  const templateOf = (path: string) => {
    const file = readFileSync(path, 'utf8');
    const end = file.indexOf('---', 3);
    return end === -1 ? file : file.slice(end + 3);
  };
  const sources = [
    templateOf('src/pages/cms/app/index.astro'),
    templateOf('src/components/cms/CmsApprovalLeaderboard.astro'),
  ];

  let counted = 0;
  for (const source of sources) {
    for (const match of source.matchAll(/\{count\(([^)]*)\)\}/g)) {
      const figure = match[1]!;
      const at = match.index!;
      // A count inside the sentence that explains an empty period is prose,
      // not a figure: it has nothing to open because there is nothing there.
      if (/outside this period/.test(source.slice(at, at + 200))) continue;
      // The row detail's own figures are a distribution readout, not dashboard
      // figures: fastest, slowest and count describe the rows already listed,
      // and the slowest is the one of the three that opens anything.
      const detailStart = source.lastIndexOf('<details class="cms-leader-detail"', at);
      if (detailStart !== -1 && source.indexOf('</details>', detailStart) > at) continue;
      counted += 1;
      const before = source.slice(Math.max(0, at - 400), at);
      assert.match(before, /<a[\s\S]*$/, `the figure count(${figure}) is not inside a link`);
    }
  }
  // THE KPI STRIP'S FIGURES ARE FIGURES TOO, and they are formatted in the
  // frontmatter because the card renders its own anchor around them. The regex
  // above cannot see inside a component, so the cards are asserted directly:
  // every one of them carries a destination, which is the property the scan
  // exists to protect rather than the string position it happens to check.
  const home = readFileSync('src/pages/cms/app/index.astro', 'utf8');
  const cards = [...home.matchAll(/<CmsKpiCard[\s\S]*?\/>/g)].map((m) => m[0]);
  assert.ok(cards.length > 0, 'Home renders no KPI card');
  for (const card of cards) {
    assert.match(card, /href=\{/, 'a KPI card carries no destination');
    assert.match(card, /value=\{/, 'a KPI card carries no figure');
  }
  // And each card is built from a list whose every entry has an href, so a
  // fifth card cannot be added without one.
  for (const strip of ['purchaseKpis', 'salesKpis']) {
    const start = home.indexOf(`const ${strip}: Kpi[] = [`);
    assert.ok(start !== -1, `${strip} is not declared`);
    const block = home.slice(start, home.indexOf('\n];', start));
    const labels = [...block.matchAll(/label: '([^']+)'/g)].length;
    const hrefs = [...block.matchAll(/\n {4}href:/g)].length;
    assert.equal(labels, 4, `${strip} should carry four measures`);
    assert.equal(hrefs, 4, `${strip} has a measure with no destination`);
    counted += 4;
  }
  assert.ok(counted >= 6, `expected Home's counts, found ${counted}`);

  // The two duration columns are links too, and they are the ones this phase
  // added: Typical and Slowest 10% each open the records behind them.
  const board = templateOf('src/components/cms/CmsApprovalLeaderboard.astro');
  // Three columns carry a figure, and each opens its own records. `breaches`
  // and `pending` went with the columns that opened them; the record page still
  // serves those views for anything else that wants them.
  for (const view of ['completed', 'typical', 'tail']) {
    assert.ok(board.includes(`records(row, '${view}')`), `${view} has no destination`);
  }

  // And the chart points, which carry their own href into the SVG.
  assert.match(
    readFileSync('src/pages/cms/app/index.astro', 'utf8'),
    /href: link\(f\.fn\)/,
    'every chart bar is a drill target',
  );
  console.log(`[drill] ${counted} linked figures on Home`);
});

test('every Home destination carries the filter and the scope', () => {
  // Destinations are built by drillTo, which serialises the whole filter. A
  // bare path would drop the period the figure was computed under and show a
  // different population from the number that was clicked.
  const source = readFileSync('src/pages/cms/app/index.astro', 'utf8');
  const hrefs = [...source.matchAll(/href=\{([^}]+)\}/g)].map((m) => m[1]!.trim());
  assert.ok(hrefs.length >= 6, `expected the destinations, found ${hrefs.length}`);
  const bare = hrefs.filter((h) => h.startsWith("'/") || h.startsWith('"/'));
  assert.deepEqual(bare, [], `destinations that lose the filter: ${bare.join(', ')}`);
  for (const name of ['toSales', 'toPurchases']) {
    assert.match(
      source,
      new RegExp(`const ${name} = \\(extra`),
      `the ${name} destination is built from drillTo`,
    );
  }
  assert.match(source, /drillTo\('\/app\/orders\/purchases', filter/);
  assert.match(source, /drillTo\('\/app\/orders\/sales', filter/);
});

test('Home leads with the two charts, then the two leaderboards', () => {
  const source = readFileSync('src/pages/cms/app/index.astro', 'utf8');

  // The charts come first, purchase orders then sales orders, and each
  // leaderboard follows its own chart inside the same column. Reading the
  // order out of the file is what proves the column reads downward: a grid
  // that placed them side by side would interleave these four markers.
  //
  // ASSERTED AGAINST MARKERS THE PAGE ACTUALLY RENDERS. The #199 merge changed
  // this test to look for `peopleByFunction(...)`, a helper from a rewrite of
  // the page that the same merge dropped, so the assertion searched for a
  // string no file contained and failed on main itself — unseen, because the
  // pipeline never reached the test step.
  const marks = [
    ...source.matchAll(
      /title="(Purchase order approval|Sales order approval)"|caption="(Purchase order approvers|Sales order approvers)"/g,
    ),
  ].map((m) => m[1] ?? m[2]!);
  assert.deepEqual(marks, [
    'Purchase order approval',
    'Purchase order approvers',
    'Sales order approval',
    'Sales order approvers',
  ]);

  // Everything that used to sit between them is gone; the one section left is
  // the exception list, and it is below all four.
  const order = [...source.matchAll(/<CmsSectionHeader\s+id="([a-z]+)"\s+title="([^"]+)"/g)].map(
    (m) => m[2]!,
  );
  assert.deepEqual(order, ['Needs attention']);
  assert.ok(
    source.indexOf('Needs attention') > source.indexOf('Sales order approvers'),
    'the exceptions sit below the leaderboards',
  );

  // Two columns that stack on a narrow screen, purchase orders first. The
  // grid is one declaration, so the source order IS the stacked order.
  assert.match(source, /grid gap-6 lg:grid-cols-2/);
});

test('the two leaderboards carry identical columns in identical order', () => {
  const home = readFileSync('src/pages/cms/app/index.astro', 'utf8');
  // ONE component, rendered twice, taking its columns from ONE module. Two
  // column literals could drift; one cannot, and the eye moving between the
  // tables depends on it.
  assert.equal(
    (home.match(/<CmsApprovalLeaderboard/g) ?? []).length,
    2,
    'both leaderboards come from the same component',
  );
  // FOUR, NOT EIGHT. Eight did not fit at a laptop width and both tables
  // scrolled sideways; a table you have to scroll to read is a table nobody
  // reads. Function became a section heading, Within SLA went because no
  // targets are configured so it was empty on every row, and Pending and
  // Oldest pending went because that information sits above the table already
  // and belongs to the function rather than to a person.
  assert.deepEqual([...LEADERBOARD_HEADERS], ['Person', 'Volume', 'Typical', 'Slowest 10%']);
  const columns = leaderboardColumns('x', 'y');
  assert.deepEqual(
    columns.map((column) => column.label),
    [...LEADERBOARD_HEADERS],
  );
  // Every column carries its own definition, so a plain-English header can
  // hide a technical name without hiding it from an auditor.
  for (const column of columns) {
    assert.ok(
      (column.definition ?? '').length > 20,
      `${column.label} has no definition a reader can open`,
    );
  }
  assert.match(columns.find((c) => c.label === 'Typical')!.definition!, /MEDIAN/);
  assert.match(columns.find((c) => c.label === 'Slowest 10%')!.definition!, /PERCENTILE/);
});

test('no average, fastest or slowest column appears in either table', () => {
  // MEASURED, NOT A PREFERENCE. One 23,002-minute hold drags an average away
  // from everybody; every person's fastest is a minute or two, so it
  // distinguishes nobody; and the slowest inverts the ranking, because a single
  // order left over a holiday decides it. Both extremes live in the row detail,
  // which ranks nothing.
  for (const label of LEADERBOARD_HEADERS) {
    assert.ok(
      !/^(Average|Mean|Fastest|Slowest|Function|Within SLA|Pending|Oldest pending)$/i.test(label),
      `${label} is a column that has been removed`,
    );
  }
  // The component defines no columns of its own, so there is nowhere for a
  // ninth to be added quietly.
  const board = readFileSync('src/components/cms/CmsApprovalLeaderboard.astro', 'utf8');
  assert.deepEqual(
    [...board.matchAll(/label: '([^']+)'/g)].map((m) => m[1]!),
    [],
  );
  // And the repository no longer computes a mean, so no page can print one.
  const repo = readFileSync('src/lib/cms/repos/approvalSla.ts', 'utf8');
  assert.ok(!/meanMinutes/.test(repo), 'approvalSla still computes a mean');
});

test('nothing in the row detail sorts or ranks', () => {
  const board = readFileSync('src/components/cms/CmsApprovalLeaderboard.astro', 'utf8');
  const start = board.indexOf('<details class="cms-leader-detail"');
  const end = board.indexOf('</details>', start);
  assert.ok(start !== -1 && end !== -1, 'the row detail is a disclosure');
  const detail = board.slice(start, end);
  assert.ok(!/\bsort|\brank|aria-sort/i.test(detail), 'the row detail must not sort or rank');
  // The extremes belong here, and the slowest opens the order that caused it.
  for (const word of ['Fastest', 'Slowest', 'Count']) {
    assert.ok(detail.includes(word), `the row detail is missing ${word}`);
  }
  assert.ok(detail.includes('row.slowestEntityId'), 'the slowest does not open its order');
});

test('a minimum volume before a rank is stated on the screen', () => {
  const board = readFileSync('src/components/cms/CmsApprovalLeaderboard.astro', 'utf8');
  assert.match(board, /Ranked from \{MINIMUM_RANKED_VOLUME\}/, 'the table states the threshold');
  // Rendered twice because the component is, so both tables state it.
  const home = readFileSync('src/pages/cms/app/index.astro', 'utf8');
  assert.equal((home.match(/<CmsApprovalLeaderboard/g) ?? []).length, 2);
});

test('a section header cannot carry a description', () => {
  // Structural, not a convention: there is no prop to pass, so the paragraph
  // under a heading cannot come back one page at a time.
  const header = readFileSync('src/components/cms/CmsSectionHeader.astro', 'utf8');
  assert.ok(!/description\??:/.test(header), 'CmsSectionHeader takes no description');
  assert.match(header, /<h2 id=\{id\}/, 'it renders an h2, so nothing is skipped');
});

test('one implementation of each dashboard component', () => {
  // A second implementation of any of these is the defect this asserts against.
  for (const [component, marker] of [
    ['CmsKpiCard', 'text-cms-kpi'],
    ['CmsStatusPill', 'rounded-full px-2 py-0.5'],
    ['CmsDataTable', '<table'],
    ['CmsLeaderboardRow', 'minimumVolume'],
    ['CmsFilterBar', 'Reset'],
    ['CmsSectionHeader', '<h2'],
  ] as const) {
    const path = `src/components/cms/${component}.astro`;
    assert.match(
      readFileSync(path, 'utf8'),
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
    // Nothing else in the CMS defines the same thing.
    const duplicates = [...walk('src/components/cms', '.astro')].filter(
      (other) => other !== path && other.toLowerCase().includes(component.toLowerCase().slice(3)),
    );
    assert.deepEqual(duplicates, [], `${component} has a near-duplicate: ${duplicates.join(', ')}`);
  }
});

test('a leaderboard cannot be built on speed alone', () => {
  // Every dimension the analytics phases require is a required prop, so a
  // caller cannot render a table of medians and call it a ranking.
  const row = readFileSync('src/components/cms/CmsLeaderboardRow.astro', 'utf8');
  for (const required of [
    'volume: number;',
    'median: string;',
    'p90: string;',
    'compliance: number | null;',
    'pending: number;',
    'oldestPending: string;',
    'minimumVolume: number;',
  ]) {
    assert.ok(row.includes(required), `${required} must be required, not optional`);
  }
  assert.match(row, /rank: number \| null;/, 'a rank can be withheld');
  assert.match(row, /unranked below/, 'and the reason is shown rather than the row dropped');
});

test('the rail is collapsed by default and opens four ways', () => {
  const layout = readFileSync('src/layouts/CmsLayout.astro', 'utf8');
  // COLLAPSED AT EVERY WIDTH. It used to default to pinned above 1280px,
  // which meant most people never met the rail this is about.
  assert.ok(!/min-width: 1280px/.test(layout), 'no width test decides the default any more');
  assert.match(layout, /localStorage\.getItem\('cms\.rail\.pinned'\) === '1'/);
  assert.match(layout, /absolute inset-y-0 left-0 h-dvh w-16 overflow-hidden/);
  assert.match(layout, /<div class="flex h-full w-56 flex-col py-4">/);
  assert.match(layout, /hover:w-56/, 'it expands on hover');
  assert.match(layout, /focus-within:w-56/, 'and on keyboard focus');
  assert.match(layout, /group-data-\[rail-touch=true\]\/rail:w-56/, 'and on a touch');
  assert.match(layout, /group-data-\[rail-pinned=true\]\/rail:w-56/, 'and when pinned');
  assert.match(layout, /transition-\[width\] duration-150/, 'the motion is short');

  const script = readFileSync('src/components/cms/CmsRailScript.astro', 'utf8');
  assert.match(script, /aria-pressed/, 'the pin reports its own state');
  assert.match(script, /localStorage\.setItem\(PIN_KEY, pinned \? '1' : '0'\)/);
  // A hover-only control is a broken control on a tablet, so touch is its own
  // path rather than something hover is expected to cover.
  assert.match(script, /pointerType !== 'touch'/, 'touch is handled explicitly');
  assert.match(script, /railTouch/, 'and it drives the same width state');

  const global = readFileSync('src/styles/global.css', 'utf8');
  assert.match(global, /transition-duration: 0\.01ms !important/);
});

test('the landing group has no heading and no disclosure', () => {
  const sidebar = readFileSync('src/components/cms/CmsSidebar.astro', 'utf8');
  // WORK IS GONE. It sat above Home, Customers, CRM, Helpdesk and Orders,
  // told nobody anything, and rendered like a heading while doing nothing
  // when pressed.
  assert.ok(!sidebar.includes("label: 'Work'"), 'the Work heading is deleted');
  assert.match(sidebar, /\{ label: null, items: \['Home',/, 'the landing group has no label');
  // And it is a plain list, not a disclosure: collapsing the thing you arrived
  // at is a control nobody wants, and it would put a control in the tab order
  // ahead of Home.
  assert.match(
    sidebar,
    /if \(group\.label === null\) \{\s*return <div class="mb-3 last:mb-0">\{items\}<\/div>;/,
    'a headingless group renders as a plain list',
  );
  // Exactly three headings remain, and no fourth was added.
  const labels = [...sidebar.matchAll(/\{ label: '([^']+)', items:/g)].map((m) => m[1]!);
  assert.deepEqual(labels, ['Insights', 'Operations', 'System']);
});

test('no label looks interactive without being a control', () => {
  // THE RULE, AND THE ONE THAT WORK BROKE. A thing that renders like a control
  // must be one. In the rail that means every remaining heading is a real
  // <summary> carrying a chevron, and the one that was not has been deleted.
  const sidebar = readFileSync('src/components/cms/CmsSidebar.astro', 'utf8');
  assert.equal(
    (sidebar.match(/<summary/g) ?? []).length,
    1,
    'one summary, rendered for the three labelled groups and for nothing else',
  );
  assert.ok(
    sidebar.indexOf('cursor-pointer') > sidebar.indexOf('<summary'),
    'the pointer cursor belongs to the summary, not to a plain heading',
  );

  // ROYAL IS THE ACTION COLOUR AND NOTHING ELSE. Using it on something that
  // cannot be pressed is the same false promise in a different place.
  const kpi = readFileSync('src/components/cms/CmsKpiCard.astro', 'utf8');
  const unlinked = kpi.slice(kpi.indexOf('    ) : ('));
  assert.ok(
    !unlinked.includes('text-cms-royal'),
    'a KPI card with no destination uses no action colour',
  );
  const leaderboard = readFileSync('src/components/cms/CmsLeaderboardRow.astro', 'utf8');
  assert.ok(
    !/bg-cms-royal-tint text-cms-royal/.test(leaderboard),
    'a rank is not a chip somebody can press',
  );
});

test('the module groups collapse, persist, and open on the current page', () => {
  const sidebar = readFileSync('src/components/cms/CmsSidebar.astro', 'utf8');
  // A native <details>, so the disclosure works with no JavaScript at all and
  // announces its own state.
  assert.match(sidebar, /<details/, 'a group is a native disclosure');
  assert.match(sidebar, /open=\{holdsCurrent\}/, 'and the server decides which one is open');
  assert.match(
    sidebar,
    /const holdsCurrent = group\.entries\.some\(\(item\) => isActive\(item\.href\)\)/,
    'from the current path, not from a script',
  );
  // A group nobody may see is not rendered at all, rather than rendered empty.
  assert.match(sidebar, /\.filter\(\(group\) => group\.entries\.length > 0\)/);
  // A closed group must not empty the 64px rail, where there is no heading to
  // explain the absence and no control to undo it.
  assert.match(sidebar, /aside\[data-cms-rail\]\) \.cms-nav-group:not\(\[open\]\) > ul/);

  const script = readFileSync('src/components/cms/CmsRailScript.astro', 'utf8');
  assert.match(script, /cms\.rail\.groups/, 'the choice is remembered');
  assert.match(script, /addEventListener\('toggle'/, 'from the element that changed');
});

// ---------------------------------------------------------------------------
// Section 6: the login page
// ---------------------------------------------------------------------------

test('the brand panel is on the left and the form on the right', () => {
  const layout = readFileSync('src/layouts/CmsAuthLayout.astro', 'utf8');
  // The form is first in the DOM so a keyboard user reaches it immediately,
  // and second on screen from lg upwards. The brand takes the first column.
  assert.match(layout, /<main[\s\S]*?lg:order-2/, 'the form is the second column');
  assert.match(layout, /<aside[\s\S]*?lg:order-1/, 'the brand is the first column');
  assert.ok(
    layout.indexOf('<main') < layout.indexOf('<aside'),
    'the form still comes first in the DOM',
  );
  // And the form side is the wider of the two.
  const grid =
    /lg:grid-cols-\[minmax\(([\d.]+)rem,([\d.]+)fr\)_minmax\(([\d.]+)rem,([\d.]+)fr\)\]/.exec(
      layout,
    );
  assert.ok(grid, 'the two columns are declared as fractions');
  assert.ok(
    Number(grid![4]) > Number(grid![2]),
    `the form column (${grid![4]}fr) must be wider than the brand (${grid![2]}fr)`,
  );
});

test('the login form causes no layout shift when an error arrives', () => {
  const page = readFileSync('src/pages/cms/login.astro', 'utf8');
  // The region occupies its height whether or not it carries a message, so
  // the fields and the button do not move at the moment the user is reaching
  // for them.
  assert.match(page, /<div class="min-h-14">/, 'the space is reserved');
  assert.match(page, /data-\[empty\]:invisible/, 'the box is hidden by visibility, not by layout');
  assert.ok(!/id="cms-login-error"[\s\S]{0,200}\bhidden\b/.test(page), 'nothing is display:none');
  assert.match(page, /errorBox\.toggleAttribute\('data-empty'/, 'the script toggles the attribute');
  // A message longer than the reserved height scrolls rather than growing.
  assert.match(page, /max-h-14 items-start gap-2\.5 overflow-y-auto/);
});

test('every control on the login form is at least 44 pixels tall', () => {
  // h-11 is 2.75rem, which is 44px at the default root size.
  const input = readFileSync('src/components/cms/CmsInput.astro', 'utf8');
  assert.match(input, /'h-11 w-full rounded-cms border/, 'the field is 44px');
  const button = readFileSync('src/components/cms/CmsButton.astro', 'utf8');
  assert.match(button, /primary: 'min-h-11 bg-cms-royal/, 'the primary action is at least 44px');
  assert.match(button, /lg: 'h-11 px-5'/, 'the large size is 44px');
  const page = readFileSync('src/pages/cms/login.astro', 'utf8');
  assert.match(page, /variant="primary"\s+size="lg"/, 'the submit uses both');
});

test('the brand panel collapses on a small screen and the form takes the width', () => {
  const layout = readFileSync('src/layouts/CmsAuthLayout.astro', 'utf8');
  // One column below lg: the grid only applies from lg upwards.
  assert.match(layout, /class="flex min-h-dvh flex-col lg:grid/);
  // And the panel's prose is desktop-only, so it cannot push the form off the
  // first screen on a phone.
  assert.match(layout, /<div class="hidden lg:block">/);
  assert.match(layout, /min-h-40[\s\S]*lg:min-h-dvh/, 'the mobile brand panel is compact');
  assert.match(layout, /<slot name="brand-character"/, 'the mascot follows the responsive panel');
});

// ---------------------------------------------------------------------------
// Section 7: loading states
// ---------------------------------------------------------------------------

test('no full-page spinner exists anywhere', () => {
  const offenders: string[] = [];
  for (const path of CMS_SOURCE) {
    const source = readFileSync(path, 'utf8');
    for (const [index, line] of source.split('\n').entries()) {
      if (!/animate-spin/.test(line)) continue;
      // The one permitted spinner is inside a button that already carries its
      // own disabled state, and it is not a page-level state.
      if (path.endsWith('CmsButton.astro')) continue;
      offenders.push(`${path}:${index + 1} ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `spinners outside a button:\n${offenders.join('\n')}`);
});

test('a skeleton waits 200ms, matches its shape, and stops under reduced motion', () => {
  const skeleton = readFileSync('src/components/cms/CmsSkeleton.astro', 'utf8');
  assert.match(skeleton, /animate-cms-skeleton/, 'it uses the delayed animation');
  assert.match(skeleton, /opacity-0/, 'and starts invisible so there is no flash');
  assert.match(tokenSource, /--animate-cms-skeleton:[\s\S]*?200ms forwards/, 'the delay is 200ms');
  assert.match(tokenSource, /cms-skeleton-pulse 1\.6s ease-in-out 200ms infinite/);

  // The global reduced-motion rule clamps every animation, which is what stops
  // this one. The fill mode still applies, so the shape appears and holds.
  const global = readFileSync('src/styles/global.css', 'utf8');
  assert.match(global, /prefers-reduced-motion: reduce/);
  assert.match(global, /animation-duration: 0\.01ms !important/);

  // It matches the shape of what replaces it: the table renders one skeleton
  // per column, in that column's own width.
  const table = readFileSync('src/components/cms/CmsDataTable.astro', 'utf8');
  assert.match(table, /columns\.map\(\(column\) => \(\s*<td/, 'one placeholder per column');
  assert.match(table, /width=\{column\.numeric \? '3rem' : '70%'\}/, 'shaped like the column');
});

// ---------------------------------------------------------------------------
// Section 8 and 10: clutter, density and rhythm
// ---------------------------------------------------------------------------

test('a card carries neither a border nor a shadow', () => {
  for (const component of ['CmsCard', 'CmsKpiCard', 'CmsDataTable', 'CmsChart']) {
    const source = readFileSync(`src/components/cms/${component}.astro`, 'utf8');
    const container = source.slice(source.indexOf('---', 3));
    assert.ok(
      !/rounded-cms-lg border border-cms-line/.test(container),
      `${component} still draws a border round a surface that is already a plane`,
    );
    assert.ok(!/shadow-cms/.test(container), `${component} still floats`);
  }
});

test('an empty table does not claim that nothing exists', () => {
  const table = readFileSync('src/components/cms/CmsDataTable.astro', 'utf8');
  const fallback = /emptyMessage = '([^']+)'/.exec(table);
  assert.ok(fallback, 'the table declares a default empty message');
  assert.notEqual(fallback![1], 'Nothing to show yet.', 'the old message is gone');
  // The MESSAGE THE COMPONENT ACTUALLY DECLARES. The #199 merge changed this
  // assertion to a wording CmsDataTable never received, so it failed on main
  // itself.
  assert.match(fallback![1]!, /An empty result is not a claim that nothing exists/);
});

test('numbers are tabular and right aligned in every table', () => {
  const table = readFileSync('src/components/cms/CmsDataTable.astro', 'utf8');
  assert.match(table, /column\.numeric \? 'text-right tabular-nums' : 'text-left'/);
  for (const component of ['CmsFigure', 'CmsKpiCard']) {
    assert.match(
      readFileSync(`src/components/cms/${component}.astro`, 'utf8'),
      /tabular-nums/,
      `${component} uses tabular figures`,
    );
  }
});

test('a long table sticks its header rather than leaving numbers unlabelled', () => {
  const table = readFileSync('src/components/cms/CmsDataTable.astro', 'utf8');
  assert.match(table, /stickyHead \? 'sticky top-0 z-10' : ''/);
  assert.match(table, /stickyHead \? 'max-h-\[32rem\] overflow-y-auto' : ''/);
});

test('a chart draws no gridlines and no markers on a dense line', () => {
  const svg = readFileSync('src/lib/cms/charts/svg.ts', 'utf8');
  // One baseline, not three rules across the plot.
  const lines = svg.slice(svg.indexOf('function frame('), svg.indexOf('function categoryLabels('));
  assert.equal((lines.match(/<line /g) ?? []).length, 1, 'the frame draws one baseline');
  assert.match(svg, /const showMarkers = count <= MARKER_LIMIT/);
  assert.match(svg, /if \(showMarkers\) \{/, 'markers are conditional');
});

test('body text never drops below 12 pixels', () => {
  // If a table does not fit, the table is wrong. Shrinking to eleven pixels to
  // win a column is how an operational tool becomes unreadable.
  const sizes = [...tokenSource.matchAll(/--text-cms-[a-z-]+:\s*([\d.]+)rem;/g)].map((m) =>
    Number(m[1]),
  );
  assert.ok(sizes.length > 5, 'the CMS type scale was found');
  const smallest = Math.min(...sizes);
  assert.ok(smallest >= 0.75, `the smallest CMS type token is ${smallest * 16}px`);
});

// ---------------------------------------------------------------------------
// Section 11: nothing regressed
// ---------------------------------------------------------------------------

test('every page still renders exactly one h1', () => {
  // The page header owns the h1, which is how the rule is kept structurally
  // rather than by discipline. A page with a literal <h1> as well has two.
  const offenders: string[] = [];
  for (const path of CMS_PAGES) {
    const source = readFileSync(path, 'utf8');
    const literal = (source.match(/<h1[\s>]/g) ?? []).length;
    const header = (source.match(/<CmsPageHeader/g) ?? []).length;
    if (literal + header > 1) offenders.push(`${path}: ${literal + header} first-level headings`);
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('the sweep touched nothing outside the CMS', () => {
  // A guard against the one mistake this phase could make that nobody would
  // notice until three other products looked wrong: editing a shared token.
  const shared = tokenSource.slice(0, tokenSource.indexOf('CMS product tokens'));
  for (const [name, value] of [
    ['--color-navy', '#0b1733'],
    ['--color-ink', '#111827'],
    ['--color-ivory', '#f8f4ea'],
    ['--color-porcelain', '#fffcf6'],
    ['--color-brass', '#a9822e'],
    ['--color-focus', '#3b82f6'],
  ] as const) {
    assert.ok(shared.includes(`${name}: ${value}`), `${name} was changed and is shared`);
  }
});

// ---------------------------------------------------------------------------
// Build Prompt 39: the period control, from one implementation
// ---------------------------------------------------------------------------

test('one period control, on every analytics page, from one implementation', () => {
  // ONE COMPONENT AND ONE MODULE. A second copy is the defect this asserts
  // against: the day two pages disagree about what "this quarter" means is the
  // day nobody can say which figure is right.
  const components = CMS_SOURCE.filter((path) => /CmsPeriod/.test(path));
  assert.deepEqual(components, ['src/components/cms/CmsPeriodControl.astro']);

  const PAGES = [
    'src/pages/cms/app/orders/purchases/performance.astro',
    'src/pages/cms/app/orders/sales/performance.astro',
    'src/pages/cms/app/crm/analytics.astro',
    'src/pages/cms/app/helpdesk/analytics.astro',
  ];
  for (const page of PAGES) {
    const source = readFileSync(page, 'utf8');
    assert.match(source, /<CmsPeriodControl/, `${page} does not carry the period control`);
    assert.match(
      source,
      /from '@\/lib\/cms\/analytics\/period'/,
      `${page} does not resolve its period from the shared module`,
    );
  }

  // HOME ASKS THE SAME QUESTION WITH TWO DROPDOWNS, and that is a deliberate
  // difference rather than a second implementation. An analytics page compares
  // arbitrary windows and needs presets, a quarter, all time and a typed range;
  // a dashboard is read one month at a time, and every extra way of asking is a
  // decision taken before the first figure is read. What must NOT differ is the
  // meaning of a month, so Home resolves its period from the same module — and
  // it renders no date input of its own, which is what stops the escape hatch
  // growing back one control at a time.
  const home = readFileSync('src/pages/cms/app/index.astro', 'utf8');
  assert.match(home, /<CmsMonthYearControl/, 'Home carries the month and year control');
  assert.ok(!/<CmsPeriodControl/.test(home), 'Home does not carry both controls');
  assert.match(
    home,
    /from '@\/lib\/cms\/analytics\/period'/,
    'Home does not resolve its period from the shared module',
  );
  const monthYear = readFileSync('src/components/cms/CmsMonthYearControl.astro', 'utf8');
  assert.ok(!/type="date"/.test(monthYear), 'the dashboard control has no date input');
  for (const field of ['name="month"', 'name="year"']) {
    assert.ok(monthYear.includes(field), `the dashboard control is missing ${field}`);
  }
  // And it reads its months and years from the period module rather than
  // listing twelve names of its own.
  assert.match(monthYear, /MONTH_OPTIONS/, 'the months come from the period module');
  assert.match(monthYear, /yearOptions/, 'the years come from the period module');

  // The presets are declared in exactly one file. A page that listed its own
  // would be a second implementation wearing the first one's name.
  const declaring = CMS_SOURCE.concat(CMS_PAGES).filter((path) =>
    /export const PRESETS/.test(readFileSync(path, 'utf8')),
  );
  assert.deepEqual(
    declaring,
    ['src/lib/cms/analytics/period.ts'],
    'the presets live in src/lib/cms/analytics/period.ts alone',
  );
  console.log(`[period] one control on ${PAGES.length} pages`);
});

/* -------------------------------------------------------------------------
 * Phase 4.2: the dashboard reads as a dashboard
 * ------------------------------------------------------------------------- */

test('Home carries no paragraph, only microcopy', () => {
  // THE GREP IS THE TEST, AND THE LIMIT IS FIVE WORDS. Home had grown a
  // sentence under every widget — why no target line is drawn, how the ranking
  // threshold works, which month the data is really in — and a dashboard that
  // has to be read rather than scanned is a report. Everything that survives is
  // a label; everything that needed explaining moved behind a definition
  // control, which is one press away and costs no pixels until it is asked for.
  const file = readFileSync('src/pages/cms/app/index.astro', 'utf8');
  const template = file.slice(file.indexOf('---', 3) + 3);
  const offenders: string[] = [];
  for (const match of template.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    // The literal words only: an interpolation is a value, not prose, and its
    // own length is asserted where it is built.
    const words = match[1]!
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&\w+;/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((word) => /[a-z]/i.test(word));
    if (words.length > 5) offenders.push(`${words.length} words: ${words.join(' ').slice(0, 70)}`);
  }
  assert.deepEqual(offenders, [], `Home still carries prose:\n${offenders.join('\n')}`);

  // A KPI's quiet line is microcopy too, and it is a prop rather than a
  // paragraph, so the scan above cannot see it.
  for (const match of file.matchAll(/context: `([^`]*)`/g)) {
    const words = match[1]!
      .replace(/\$\{[^}]*\}/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((word) => /[a-z]/i.test(word));
    assert.ok(words.length <= 5, `a KPI line runs to ${words.length} words: ${match[1]}`);
  }

  // The sentences that were there are gone by name, so they cannot drift back.
  for (const gone of [
    'so no target line is drawn',
    'completions sit in other periods',
    'which is too few to compare',
    'stays in view under',
  ]) {
    assert.ok(!file.includes(gone), `Home still says "${gone}"`);
  }
});

test('the leaderboard states its caveats rather than explaining them', () => {
  const board = readFileSync('src/components/cms/CmsApprovalLeaderboard.astro', 'utf8');
  const template = board.slice(board.indexOf('---', 3) + 3);
  const offenders: string[] = [];
  for (const match of template.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)) {
    // FRAGMENT BY FRAGMENT, because a meta line is several pieces of microcopy
    // separated by a middot, not one sentence. Each piece is held to the limit;
    // joining two of them with a separator does not buy either more words.
    for (const piece of match[1]!.split('·')) {
      const words = piece
        .replace(/\{[^}]*\}/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .trim()
        .split(/\s+/)
        .filter((word) => /[a-z]/i.test(word));
      if (words.length > 5)
        offenders.push(`${words.length} words: ${words.join(' ').slice(0, 70)}`);
    }
  }
  assert.deepEqual(offenders, [], `the leaderboard still carries prose:\n${offenders.join('\n')}`);
  for (const gone of [
    'Listed from the first completion',
    'below that, figures are shown',
    'so there is nobody to list',
    'so no comparative position',
  ]) {
    assert.ok(!board.includes(gone), `the leaderboard still says "${gone}"`);
  }
});

test('every Home chart names both of its axes', () => {
  // A TICK SAYS "37 min"; A TITLE SAYS WHAT IS BEING MEASURED. Both charts on
  // both panels carry the pair, and the trend's are the two the brief names:
  // months across, minutes up.
  const home = readFileSync('src/pages/cms/app/index.astro', 'utf8');
  assert.equal(
    (home.match(/xAxisLabel:/g) ?? []).length,
    2,
    'the bar chart and the trend each name their x axis',
  );
  assert.equal((home.match(/yAxisLabel:/g) ?? []).length, 2, 'and each names its y axis');
  assert.match(
    home,
    /xAxisLabel: 'Month',\n\s*yAxisLabel: 'Minutes',/,
    'the trend is months by minutes',
  );
  assert.match(
    home,
    /xAxisLabel: 'Minutes',\n\s*yAxisLabel: 'Function',/,
    'the bars are minutes by function',
  );

  // The chart module draws them, rather than a page hand-placing text in SVG.
  const svg = readFileSync('src/lib/cms/charts/svg.ts', 'utf8');
  assert.match(svg, /function axisTitles\(/, 'one implementation draws every axis title');
});

test('the Home trend is a line over months, not a scatter over days', () => {
  const home = readFileSync('src/pages/cms/app/index.astro', 'utf8');
  // ONE VALUE PER MONTH, over the year ending at the month on screen. Bucketing
  // one month's DAYS is what produced the scatter: a mark wherever an approval
  // landed and a gap on every other day.
  assert.match(home, /approvalTrend\(client, 'PURCHASE_ORDER', trendScope, 'MONTH'\)/);
  assert.match(home, /approvalTrend\(client, 'SALES_ORDER', trendScope, 'MONTH'\)/);
  assert.match(
    home,
    /trailingMonths\(shown, trendSpan\(shown, calendar\)\)/,
    'the window is the months ending at this one, sized to the data',
  );
  assert.ok(!/approvalTrend\([^)]*shown\.grain/.test(home), 'the trend no longer follows the span');

  // And the line is a line: a stroked path, with the markers as decoration on
  // it rather than the whole of it.
  const svg = readFileSync('src/lib/cms/charts/svg.ts', 'utf8');
  assert.match(svg, /stroke="var\(--color-\$\{one\.token\}\)" stroke-width="2"/);

  // ONE MONTH IS NOT A TREND. The purchase order extract covers a single month,
  // and a line chart over it drew one dot per function against a row of empty
  // months, which is the scatter the brief asked to be rid of.
  assert.match(home, /minimumCategories: 2,/, 'a trend needs two months before it draws');
});

test('a chart never clips the units off its own axis', () => {
  // The sales order trend reads in hours, so its top tick is "8 h 20 min" and a
  // fixed 56-pixel gutter cut it to "h 20 min". An axis whose unit is sliced
  // off is not an axis, so the gutter is measured from the labels themselves.
  const line = lineChart(
    [
      {
        name: 'Finance approval',
        token: 'cms-series-1',
        points: [
          { label: 'Apr', value: 100 },
          { label: 'May', value: 500 },
        ],
      },
    ],
    { format: formatDuration, yAxisLabel: 'Minutes', xAxisLabel: 'Month' },
  );
  const ticks = [...line.svg.matchAll(/<text x="(-?\d+)" y="\d+" text-anchor="end"/g)];
  assert.ok(ticks.length >= 3, 'three ticks are drawn');
  for (const tick of ticks) assert.ok(Number(tick[1]) >= 8, 'no tick starts off the left edge');
  const widest = Math.max(...line.table.rows.map((row) => (row[1] ?? '').length));
  assert.ok(widest >= 8, 'this fixture really does carry a long duration');
  // Both titles are still drawn, and the plot starts after the gutter.
  assert.match(line.svg, /MINUTES/);
  assert.match(line.svg, /MONTH/);
});

test('a trend with one month of history says so instead of drawing a scatter', () => {
  const one = [
    {
      name: 'Finance approval',
      token: 'cms-series-1',
      points: [
        { label: 'Apr', value: null },
        { label: 'May', value: 20 },
      ],
    },
  ];
  const stood = lineChart(one, { minimumCategories: 2, emptyMessage: 'Need more history' });
  assert.match(stood.svg, /Need more history/);
  assert.equal(/<path d="M/.test(stood.svg), false, 'no line is drawn over one month');
  assert.ok(!stood.svg.includes('MINUTES'), 'and no axis is titled over a plot that is not there');
  // The numbers are not lost: the alt says why, then reads the value out, and
  // the table underneath still carries it.
  assert.match(stood.alt, /^Need more history\./);
  assert.match(stood.alt, /20/);
  assert.equal(stood.table.rows.length, 2);
  // Two months of history and it draws.
  const drawn = lineChart(
    [
      {
        ...one[0]!,
        points: [
          { label: 'Apr', value: 10 },
          { label: 'May', value: 20 },
        ],
      },
    ],
    { minimumCategories: 2, emptyMessage: 'Need more history' },
  );
  assert.equal(drawn.svg.includes('Need more history'), false);
  assert.match(drawn.svg, /<path d="M/);
});

test('no From, To or Trend control survives on an analytics page', () => {
  // The panel this replaced asked a person to type a date twice and then asked
  // for a grain the period already answers. All three are gone, and the only
  // date input left in the application is the one behind Custom.
  const shared = readFileSync('src/components/cms/CmsOrderFilters.astro', 'utf8');
  // The only `from` and `to` left in this form are hidden fields carrying a
  // CUSTOM period through the GET submit, which is the opposite of a control:
  // nobody sees them and nobody types into them.
  assert.ok(
    !/<CmsInput[^>]*name="(from|to)"/.test(shared),
    'the two date boxes are gone from the filter form',
  );
  assert.ok(!/label="Trend grain"/.test(shared), 'the trend grain control is gone');
  assert.ok(!/id="f-grain"/.test(shared), 'the trend grain control is gone');
  assert.ok(!/id="f-from"|id="f-to"/.test(shared), 'the two date boxes are gone');

  // The one remaining typed date is inside Custom, which is where it belongs.
  const control = readFileSync('src/components/cms/CmsPeriodControl.astro', 'utf8');
  const custom = control.slice(control.indexOf('Custom', control.indexOf('uppercase">')));
  assert.match(custom, /type="date"/, 'Custom is where a date is typed');
  assert.equal(
    (control.match(/type="date"/g) ?? []).length,
    2,
    'exactly two typed dates exist, both inside Custom',
  );
});

test('the empty periods are marked without relying on colour', () => {
  const control = readFileSync('src/components/cms/CmsPeriodControl.astro', 'utf8');
  // Dimming alone is colour carrying meaning. The accessible name says it too.
  assert.match(control, /no data/, 'an empty period says so in its accessible name');
  assert.match(control, /aria-label=\{mark\(/, 'every drill cell carries the mark');
});

test('the leaderboard groups by function and carries only people', () => {
  const board = readFileSync('src/components/cms/CmsApprovalLeaderboard.astro', 'utf8');

  // FUNCTION IS A HEADING, NOT A COLUMN. A real row header with a colspan, so
  // a screen reader announces the rows beneath it as belonging to it rather
  // than meeting a styled cell.
  assert.match(board, /scope="colgroup"/, 'the function heading is a real group header');
  assert.match(board, /colspan=\{COLUMNS\.length\}/, 'it spans the table');
  // Grouped, and a person acting in two functions appears once under each,
  // because the grouping is by the row's own function rather than by person.
  assert.match(board, /groups\.find\(\(group\) => group\.fn === row\.fn\)/);

  // A LEADERBOARD IS PEOPLE. A function whose extract records no actor is
  // excluded whole — dropping the null rows and keeping the function would
  // leave an empty heading claiming somebody worked on it.
  assert.match(board, /filter\(\(row\) => row\.userId !== null\)/);
  // And it is named beneath, so the same fact is still on the page — now as a
  // caption rather than the sentence it used to be, because a dashboard states
  // a caveat and a memo explains it. Matched on whitespace-normalised source,
  // because the formatter is free to rewrap and an assertion that breaks when
  // it does is testing prettier.
  const flat = board.replace(/\s+/g, ' ');
  assert.match(flat, /title=\{listOf\(withoutActor\)\}>No approver recorded</);

  // The three removed columns leave no trace in the markup.
  for (const gone of ['Within SLA', 'Oldest pending', 'oldestPendingAt', 'row.pending']) {
    assert.ok(!board.includes(gone), `${gone} still appears in the leaderboard`);
  }
});

test('a panel never renders empty in silence while its own data is elsewhere', () => {
  const home = readFileSync('src/pages/cms/app/index.astro', 'utf8');
  // THE PAGE-LEVEL FALLBACK IS NOT ENOUGH, and that is the whole lesson: it
  // moves the period when NOTHING on the page has data, which is false the
  // moment one board has data and the other does not.
  assert.match(home, /const elsewhere = /, 'each panel checks its own board');
  assert.equal(
    (home.match(/elsewhere\((purchase|sales)Calendar/g) ?? []).length >= 2,
    true,
    'both panels carry the check',
  );
  // The count under each table is that board's own, never the page's mixed
  // total across every entity type.
  assert.match(home, /totalOutside=\{outsideFor\(purchaseCalendar, purchases\)\}/);
  assert.match(home, /totalOutside=\{outsideFor\(salesCalendar, sales\)\}/);
  assert.ok(!/totalOutside=\{outside\}/.test(home), 'the mixed page total is gone');

  // The period is still resolved ONCE for the page.
  assert.equal(
    (home.match(/choosePeriod\(/g) ?? []).length,
    1,
    'the period must be resolved once for the page',
  );
});

// ---------------------------------------------------------------------------
// Build Prompt 40: the assistant panel, and where Customers lives
// ---------------------------------------------------------------------------

/**
 * A file with its comments removed.
 *
 * These assertions are about what the code DOES, and the comments in this
 * codebase explain at length why a thing is absent — "no avatars", "never
 * innerHTML". Scanning the prose for the word makes the assertion fail on the
 * explanation of the rule it is enforcing.
 */
const codeOf = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

test('the assistant reads as one calm column', () => {
  const panel = codeOf('src/components/cms/CmsAssistant.astro');

  // ONE COLUMN, 60 TO 75 CHARACTERS. A wide chat is hard to read because the
  // eye loses the line return on the way back.
  assert.match(panel, /max-w-\[68ch\]/, 'the message body is measured in characters');

  // THE SPEAKERS DIFFER BY POSITION AND TONE, NOT BY TWO LOUD COLOURS. The
  // person is on the royal tint at the trailing edge; the assistant is on the
  // canvas at the leading edge. No dark bubble either way.
  assert.match(
    panel,
    /self-end rounded-cms bg-cms-royal-tint/,
    'the person is tinted and trailing',
  );
  assert.match(panel, /self-start text-cms-body-sm/, 'the assistant is plain and leading');
  assert.ok(!/bg-cms-navy/.test(panel), 'no dark bubbles');

  // NOTHING DECORATIVE. No gradient, no second elevation level, no typing dots
  // implying a person at a keyboard, no avatars, no bubble tail, no emoji.
  for (const banned of ['gradient', 'shadow-', 'avatar', 'Avatar']) {
    assert.ok(!panel.includes(banned), `the assistant panel carries ${banned}`);
  }
  // One still dot, not three animated ones.
  assert.equal(
    (panel.match(/cms-assistant-dot/g) ?? []).length,
    2,
    'exactly one indicator dot, declared once and styled once',
  );

  // THE INDICATOR SITS WHERE THE REPLY WILL APPEAR, so the answer replaces it
  // in place and nothing jumps.
  const flat = panel.replace(/\s+/g, ' ');
  assert.match(
    flat,
    /const reply = turn\('Assistant'\);.*working/s,
    'the indicator is in the turn',
  );
  assert.match(panel, /working\.remove\(\)/, 'and the reply takes its place');

  // AND IT IS STILL UNDER prefers-reduced-motion, via the global clamp rather
  // than a second rule here that could drift from it.
  const global = readFileSync('src/styles/global.css', 'utf8');
  assert.match(global, /animation-duration: 0\.01ms !important|transition-duration: 0\.01ms/);
});

test('the assistant composer is an anchor, and Enter sends', () => {
  const panel = readFileSync('src/components/cms/CmsAssistant.astro', 'utf8');
  // FIXED AT THE FOOT: the transcript scrolls, the composer does not move as
  // messages arrive.
  assert.match(
    panel,
    /flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto/,
    'the transcript scrolls',
  );
  assert.match(panel, /shrink-0 border-t border-cms-line/, 'the composer is pinned');
  // At least 44px, which is the smallest thing a finger reliably hits.
  assert.match(panel, /min-h-11/, 'the field is at least 44px');
  assert.match(panel, /h-11 shrink-0/, 'and so is the send button');
  // Enter submits, Shift+Enter is a newline.
  assert.match(panel, /event\.key === 'Enter' && !event\.shiftKey/);

  // SPACE BETWEEN TURNS EXCEEDS SPACE WITHIN ONE. gap-5 is 1.25rem between
  // turns; gap-1 is 0.25rem between a speaker's label and their words.
  assert.match(panel, /gap-5 overflow-y-auto/, 'turns are separated by 1.25rem');
  assert.match(panel, /flex-col gap-1 self-(end|start)/, 'and a turn groups at 0.25rem');
});

test('a long answer is rendered as text, never as markup', () => {
  const panel = codeOf('src/components/cms/CmsAssistant.astro');
  // Paragraphs, lists and short headings, built with textContent. Rendering a
  // model's output through innerHTML is the injection the CSP exists to
  // prevent, and a Markdown dependency is one this phase may not add.
  assert.ok(!/innerHTML/.test(panel), 'the assistant never writes markup from a response');
  assert.match(panel, /\.textContent = /, 'every node is built from text');
  assert.match(panel, /createElement\(\/\^\\d\/\.test\(lines\[0\]!\) \? 'ol' : 'ul'\)/);
});

test('Customers sits in Operations, immediately before Data', () => {
  const rail = readFileSync('src/components/cms/CmsSidebar.astro', 'utf8');
  assert.match(rail, /\{ label: 'Operations', items: \['Customers', 'Data'\] \}/);
  // And it is not left behind in the landing group.
  assert.match(rail, /\{ label: null, items: \['Home', 'CRM', 'Helpdesk', 'Orders'\] \}/);
  assert.equal(
    (rail.match(/'Customers'/g) ?? []).length,
    1,
    'Customers appears in exactly one group',
  );
  // The order is the GROUP's, not the navigation model's, so moving an item
  // between groups cannot silently reorder it.
  assert.match(rail, /group\.items\s*\n?\s*\.map\(\(label\) => entries\.find/);

  // Hidden entirely without the permission: visibleNav filters on the resolved
  // codes, and an empty group is dropped whole.
  const nav = readFileSync('src/lib/cms/nav.ts', 'utf8');
  assert.match(nav, /permission: 'CUSTOMERS\.ACCOUNTS\.VIEW'/);
  assert.match(rail, /\.filter\(\(group\) => group\.entries\.length > 0\)/);
});

test('the rail says when a pin is in force', () => {
  // THE CAUSE OF "IT DOES NOT COLLAPSE". The collapse shipped and works; a rail
  // that stays open is one where somebody pressed "Keep open" in that browser,
  // possibly months ago. localStorage outranks a later change of default
  // silently and for ever, and nothing on screen said a preference existed, so
  // the only reading available was that the collapse was broken.
  const script = readFileSync('src/components/cms/CmsRailScript.astro', 'utf8');
  assert.match(script, /Kept open in this browser/, 'the pinned state is stated');
  const layout = readFileSync('src/layouts/CmsLayout.astro', 'utf8');
  assert.match(layout, /data-cms-rail-pin-note/, 'and there is somewhere to state it');
});
