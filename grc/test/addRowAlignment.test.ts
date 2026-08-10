/**
 * The add-row alignment invariant (Build Prompt 52).
 *
 * `.grc-field` declares three grid rows so a form grid can line labels,
 * controls and helper text up across columns through subgrid. In an inline add
 * row there is no helper text, but the empty third track still contributes its
 * row gap, so the field's box ended one step below its control and every Add
 * button sat that much lower than the input it submits.
 *
 * The fix is one rule, and it is invisible to every other test in this suite: a
 * page renders identically whether or not it is there, and only a person
 * looking at the screen would notice it come back. This pins it, and pins the
 * reason, so the rule is not tidied away as redundant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'styles', 'grc.css'), 'utf8');

/** The declarations inside one rule, by its exact selector. */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `the stylesheet must still carry a ${selector} rule`);
  return CSS.slice(at, CSS.indexOf('}', at));
}

test('an add row aligns its button with the control, not below it', () => {
  const bar = ruleBody('.grc-actionbar:has(> .grc-field)');
  assert.match(bar, /align-items:\s*end/, 'the row aligns its items to their ends');

  const field = ruleBody('.grc-actionbar > .grc-field');
  // Two rows, label and control: the third exists only to hold helper text, and
  // an add row has none, so reserving it only lengthens the box.
  assert.match(
    field,
    /grid-template-rows:\s*auto auto\s*;/,
    'an add-row field must not reserve the empty helper-text row',
  );
  assert.match(field, /margin-bottom:\s*0/, 'and must not carry its own bottom margin');
});

test('the form grid still reserves all three rows, so hints stay aligned there', () => {
  // The two rules answer different questions and must not be collapsed: a form
  // grid needs the third row precisely because it does show helper text.
  const field = ruleBody('.grc-field');
  assert.match(field, /grid-template-rows:\s*auto auto auto/, 'the base field keeps three rows');
});
