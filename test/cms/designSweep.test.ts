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
  for (let n = 1; n <= 5; n++) {
    pairs.push([`chart series ${n} on surface`, token(`cms-series-${n}`), surface, 4.5]);
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

test('exactly one elevation level exists, and only overlays use it', () => {
  const shadows = [...tokenSource.matchAll(/^\s*--shadow-(cms-[a-z-]+):/gm)].map((m) => m[1]!);
  assert.deepEqual(shadows, ['cms-overlay'], `CMS shadow tokens: ${shadows.join(', ')}`);

  // A card does not float. Only something that genuinely floats over the page
  // and can be dismissed may carry the one shadow.
  const users = CMS_SOURCE.filter((p) => readFileSync(p, 'utf8').includes('shadow-cms-overlay'));
  const floats = /Drawer|Modal|Dropdown|Tooltip|Toast|Definition|Overlay|TopBar|Layout|Search/;
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
    assert.match(source, /hover:underline/, `${component} changes on hover`);
    assert.match(source, /Open the records behind this figure/, `${component} says so to a reader`);
  }
});

test('every figure on the executive dashboard carries a destination', () => {
  const source = readFileSync('src/pages/cms/app/executive.astro', 'utf8');
  const figures = [...source.matchAll(/label: '([^']+)',\n\s*value:/g)].map((m) => m[1]!);
  assert.ok(figures.length >= 20, `expected the dashboard's figures, found ${figures.length}`);

  // A figure object is the one carrying a denominator, which distinguishes it
  // from a chart's data points, whose label and value mean something else.
  const blocks = source
    .split(/\{\s*\n\s*label: /)
    .slice(1)
    .map((block) => block.slice(0, block.indexOf('},')))
    .filter((block) => block.includes('denominator:'));
  assert.equal(blocks.length, figures.length, 'every figure object was found');
  const missing = blocks
    .filter((block) => !/href:/.test(block))
    .map((block) => block.slice(0, block.indexOf('\n')));
  assert.deepEqual(missing, [], `figures with no destination: ${missing.join(', ')}`);
  console.log(`[drill] ${figures.length} dashboard figures, every one with a destination`);
});

test('every dashboard destination carries the filter and the scope', () => {
  const source = readFileSync('src/pages/cms/app/executive.astro', 'utf8');
  // Destinations are built by drillTo, which serialises the whole filter. A
  // bare path would drop the period the figure was computed under and show a
  // different population from the number that was clicked.
  const hrefs = source
    .split(/\{\s*\n\s*label: /)
    .slice(1)
    .map((block) => block.slice(0, block.indexOf('},')))
    .filter((block) => block.includes('denominator:'))
    .flatMap((block) => [...block.matchAll(/href:\s*([^,\n]+)/g)].map((m) => m[1]!.trim()));
  assert.ok(hrefs.length > 20, `expected a destination per figure, found ${hrefs.length}`);
  const bare = hrefs.filter(
    (h) => h.startsWith("'/") || (h.startsWith('`/') && !h.includes('drillTo')),
  );
  assert.deepEqual(bare, [], `destinations that lose the filter: ${bare.join(', ')}`);
  for (const name of ['service', 'crm', 'sales', 'purchases']) {
    assert.match(
      source,
      new RegExp(`const ${name} = drillTo\\('/app/`),
      `the ${name} destination is built with drillTo`,
    );
  }
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
  const grid = /lg:grid-cols-\[minmax\(([\d.]+)rem,(\d)fr\)_minmax\(([\d.]+)rem,(\d)fr\)\]/.exec(
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
  assert.match(layout, /hidden max-w-sm text-cms-display[^"]*lg:block/);
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
