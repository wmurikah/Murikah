/**
 * What the finding's own page must show, and what it must never say
 * (Build Prompt 63).
 *
 * TWO FAULTS OF THE SAME KIND: a screen that renders a subset of what is stored,
 * and a screen that renders something meant for a log. The observation title was
 * stored, written into every email, editable on the form, and absent from the
 * panel that describes the finding, which is exactly how Classification and
 * Standards went missing before it. And an auditor opening a submitted finding
 * was shown "Start review: your role does not hold WORK_PAPER.approve", a
 * permission code in front of somebody who cannot act on it.
 *
 * Both checks are mechanical, and both would have caught their fault: the first
 * compares the writable field map against the template, the second reads the
 * templates for the reason text and for the API that carries it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const DETAIL = join(REPO, 'src', 'pages', 'grc', 'work-papers', '[id].astro');
const REPOSITORY = join(REPO, 'src', 'lib', 'grc', 'repos', 'workPapers.ts');
const CARDS = join(REPO, 'src', 'lib', 'grc', 'reports', 'findingCards.ts');

/**
 * Fields whose value the detail resolves through a joined name rather than the
 * stored id, and the name it renders instead. Showing a raw `AA-FIN` where an
 * audit area belongs would be rendering the field and still not showing it.
 */
const SHOWN_AS: Record<string, string> = {
  audit_area_id: 'audit_area_name',
  sub_area_id: 'sub_area_name',
  affiliate_code: 'affiliate_name',
  assigned_auditor_id: 'assigned_auditor_name',
};

/** The writable columns, read from the one map create, update and the form share. */
function writableColumns(): string[] {
  const source = readFileSync(REPOSITORY, 'utf8');
  const start = source.indexOf('const FIELDS:');
  assert.ok(start > 0, 'the writable field map must still be called FIELDS');
  const block = source.slice(start, source.indexOf('];', start));
  return [...block.matchAll(/col:\s*'([a-z_]+)'/g)].map((m) => m[1]);
}

test('the detail shows every field a work paper stores', () => {
  const columns = writableColumns();
  assert.ok(columns.length > 15, `only ${columns.length} writable columns were found`);

  const template = readFileSync(DETAIL, 'utf8');
  const missing = columns.filter((col) => {
    const shown = SHOWN_AS[col];
    return !template.includes(`'${col}'`) && !(shown && template.includes(shown));
  });

  assert.deepEqual(
    missing,
    [],
    `these fields are stored and editable but the detail renders none of them: ${missing.join(', ')}`,
  );
});

test('the finding panel names the observation and its description, in that order', () => {
  // Build Prompt 63 put the stored title on this panel, because a page can name
  // a record in its heading and still fail to show the field. Build Prompt 67
  // moved the pair into the shared card arrangement, so the assertion moved
  // with them: the arrangement is what all three renderers read, and it is
  // where "Observation, then Description" is now decided.
  const cards = readFileSync(CARDS, 'utf8');
  assert.match(
    cards,
    /\{ kind: 'title', text: source\.observationTitle \}/,
    'the stored title is the observation card is own title (Build Prompt 71)',
  );
  assert.match(
    cards,
    /\{ kind: 'rich', text: source\.observationDescription \}/,
    'and the stored body is the formatted narrative beside it',
  );
  const template = readFileSync(DETAIL, 'utf8');
  assert.ok(
    !/<dt>Observation title<\/dt>/.test(template),
    'the old label must be gone, not merely duplicated',
  );
  assert.ok(
    /GrcFindingCards/.test(template),
    'and the detail draws the finding through the shared arrangement',
  );
});

test('the finding follows the testing that found it, and precedes the risk it carries', () => {
  // The order is the argument a finding makes: this is what we tested, this is
  // what we found, this is what it means, this is what to do. The context list
  // ends at the testing steps, and the cards pick the story up from there.
  const template = readFileSync(DETAIL, 'utf8');
  const steps = template.indexOf('<dt>Testing steps</dt>');
  const cards = template.indexOf('<GrcFindingCards');
  assert.ok(steps > 0, 'the context list must still carry the testing steps');
  assert.ok(cards > steps, 'and the finding cards must follow them');
  assert.ok(!/<dt>Risk rating<\/dt>/.test(template), "the risk is the card's, not a row above it");
});

function grcTemplates(): string[] {
  const roots = [
    join(REPO, 'src', 'pages', 'grc'),
    join(REPO, 'src', 'components', 'grc'),
    join(REPO, 'src', 'layouts'),
  ];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.astro')) out.push(full);
    }
  };
  for (const root of roots) walk(root);
  return out;
}

test('no screen renders a permission reason', () => {
  const offenders: string[] = [];
  for (const file of grcTemplates()) {
    const source = readFileSync(file, 'utf8');
    // The reason text itself, and the API that carries it: a template that asks
    // for the withheld list is a template one line away from rendering it.
    const rendersReason = /does not hold|reserves it for the/.test(source);
    const takesWithheld = /availableActions|WithheldAction|\bwithheld\b/.test(
      source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
    );
    if (rendersReason || takesWithheld) {
      offenders.push(relative(REPO, file).split(sep).join('/'));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these templates carry permission-reason text or the API that supplies it: ${offenders.join(', ')}`,
  );
});

test('the offer API a template uses carries no reasons at all', () => {
  // `offeredActions` returns what the actor may do and nothing else, so a
  // template cannot render a reason even by accident.
  const workflow = readFileSync(
    join(REPO, 'src', 'lib', 'grc', 'workflow', 'workPaperWorkflow.ts'),
    'utf8',
  );
  const signature = workflow.slice(workflow.indexOf('export async function offeredActions'));
  assert.ok(
    signature.startsWith('export async function offeredActions'),
    'offeredActions must still exist as the template-facing offer',
  );
  assert.ok(
    /Promise<OfferedAction\[\]>/.test(signature.slice(0, 400)),
    'and must return offered actions alone, never the withheld ones',
  );
});
