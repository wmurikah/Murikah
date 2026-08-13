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
  // renamed the pair and moved them together: the title is "Observation", its
  // body is "Description", and the two are adjacent, in that order. The columns
  // behind them are unchanged, which is what the val() calls assert.
  const template = readFileSync(DETAIL, 'utf8');
  assert.ok(
    /<dt>Observation<\/dt>\s*<dd>\{val\('observation_title'\)\}<\/dd>/.test(template),
    'the panel must carry the stored title, labelled Observation',
  );
  assert.ok(
    /<dt>Description<\/dt>\s*<dd class="grc-richbody" set:html=\{rich\('observation_description'\)\} \/>/.test(
      template,
    ),
    'and the stored body, labelled Description and formatted',
  );
  assert.ok(
    !/<dt>Observation title<\/dt>/.test(template),
    'the old label must be gone, not merely duplicated',
  );
});

test('the finding follows the testing that found it, and precedes the risk it carries', () => {
  // The order is the argument a finding makes: this is what we tested, this is
  // what we found, this is what it means, this is what to do. The title used to
  // sit at the very top, before Year, where it read as a second reference.
  const template = readFileSync(DETAIL, 'utf8');
  const at = (label: string): number => {
    const i = template.indexOf(`<dt>${label}</dt>`);
    assert.ok(i > 0, `the panel must carry ${label}`);
    return i;
  };
  const steps = at('Testing steps');
  const observation = at('Observation');
  const description = at('Description');
  const rating = at('Risk rating');
  const recommendation = at('Recommendation');
  assert.ok(steps < observation, 'the observation follows the testing steps');
  assert.ok(observation < description, 'the description follows the observation it describes');
  assert.ok(description < rating, 'the risk rating follows the finding');
  assert.ok(rating < recommendation, 'and the recommendation comes last of the four');
  // Nothing may sit between the two: they are one thought.
  assert.ok(
    !/<dt>/.test(
      template.slice(template.indexOf("<dd>{val('observation_title')}</dd>"), description),
    ),
    'no field may come between the observation and its description',
  );
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
