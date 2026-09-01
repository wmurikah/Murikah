/**
 * The modal lifecycle: one button, one modal, never stacked dialogs.
 *
 * The defect this pins down: the case page could show "Add activity" and
 * "Record communication" as two stacked modal surfaces, because content
 * components opened their own dialogs with private showModal() calls instead
 * of going through the one shared lifecycle in CmsOverlayScript. The fix is
 * architectural — triggers carry data-cms-modal-open, components only prepare
 * their forms, and the shared open refuses to stack — so the tests assert the
 * architecture: which file may say showModal(), and what every trigger must
 * carry. A regression is a text change in exactly these places.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(path, 'utf8');

// ---- The shared lifecycle owns every open ----------------------------------

test('only the shared overlay script opens the shell dialogs it manages', () => {
  // The four content components that share record pages (and once stacked)
  // may PREPARE their forms on a trigger click, but never open them.
  for (const path of [
    'src/components/cms/CmsActivitySection.astro',
    'src/components/cms/CmsCaseActions.astro',
    'src/components/cms/CmsLeadActions.astro',
    'src/components/cms/CmsOpportunityActions.astro',
  ]) {
    assert.ok(
      !read(path).includes('.showModal('),
      `${path} opens a dialog itself — the open belongs to CmsOverlayScript`,
    );
  }
  assert.match(read('src/components/cms/CmsOverlayScript.astro'), /dialog\.showModal\(\)/);
});

test('the shared open refuses to stack a second dialog', () => {
  const script = read('src/components/cms/CmsOverlayScript.astro');
  // The invariant: any dialog already open — content modal or the navigation
  // drawer — means the new one does not open. Refusal, not queueing, not a
  // silent close of the first: nothing is discarded.
  const openFn = script.slice(script.indexOf('const open = ('));
  const guard = openFn.indexOf("document.querySelector('dialog[open]') !== null) return");
  const show = openFn.indexOf('dialog.showModal()');
  assert.ok(guard !== -1, 'the one-dialog-at-a-time guard is gone');
  assert.ok(guard < show, 'the guard must run before showModal, not after');
  // Which also means Escape can never close one modal to reveal another:
  // a second was never allowed to open beneath or above the first.
});

test('closing hands focus back to the exact control that opened the dialog', () => {
  const script = read('src/components/cms/CmsOverlayScript.astro');
  assert.match(script, /openedBy\.set\(dialog, opener\)/);
  assert.match(script, /opener\.isConnected\) opener\.focus\(\)/);
  // And no component re-implements a private focus return.
  for (const path of [
    'src/components/cms/CmsActivitySection.astro',
    'src/components/cms/CmsCaseActions.astro',
  ]) {
    assert.ok(!/openedBy|\.focus\(\)/.test(read(path)), `${path} runs its own focus lifecycle`);
  }
});

// ---- Add activity ----------------------------------------------------------

test('Add activity is a real button whose form lives in a modal, not inline', () => {
  const section = read('src/components/cms/CmsActivitySection.astro');
  // A button, carrying both the shared open and its own prepare hook.
  const trigger = section.indexOf('data-cms-activity-add');
  assert.ok(trigger !== -1);
  assert.match(section, /data-cms-activity-add\s+data-cms-modal-open="cms-activity-modal"/);
  // The form renders inside the modal, after the trigger — never inline
  // between the heading and the timeline.
  const modal = section.indexOf('<CmsModal id="cms-activity-modal"');
  const form = section.indexOf('<form id="cms-activity-form"');
  assert.ok(modal !== -1 && form > modal, 'the activity form must live inside the modal');
  assert.ok(trigger < modal, 'the trigger is on the page, the form is not');
});

test('opening Add activity prepares a clean form every time', () => {
  const section = read('src/components/cms/CmsActivitySection.astro');
  const prepare = section.slice(
    section.indexOf("closest('[data-cms-activity-add]')"),
    section.indexOf("closest('[data-cms-activity-save]')"),
  );
  assert.match(prepare, /form\.reset\(\)/);
  assert.match(prepare, /doneBox\.checked = true/, 'Already happened returns to its default');
  assert.match(prepare, /sync\(\)/, 'progressive fields are brought back in step');
  assert.match(prepare, /errorBox\.hidden = true/, 'a stale error must not greet the next open');
});

// ---- The case actions ------------------------------------------------------

test('every case action trigger opens its modal through the shared system', () => {
  const page = read('src/pages/cms/app/helpdesk/[caseId].astro');
  assert.match(page, /data-cms-case-status\s+data-cms-modal-open="cms-case-status-modal"/);
  assert.match(page, /data-cms-case-assign\s+data-cms-modal-open="cms-case-assign-modal"/);
  assert.match(page, /data-cms-case-communicate\s+data-cms-modal-open="cms-case-comm-modal"/);
  // Record communication stays its own action and its own modal — never
  // merged with Add activity, which records a different business fact.
  const actions = read('src/components/cms/CmsCaseActions.astro');
  assert.match(actions, /<CmsModal id="cms-case-comm-modal" title="Record communication"/);
  assert.match(read('src/components/cms/CmsActivitySection.astro'), /title="Add activity"/);
});

test('the lead and opportunity triggers use the same safe lifecycle', () => {
  const lead = read('src/pages/cms/app/crm/[leadId].astro');
  for (const id of [
    'cms-lead-first-contact',
    'cms-lead-qualify',
    'cms-lead-disqualify',
    'cms-lead-convert',
  ]) {
    assert.match(lead, new RegExp(`data-cms-modal-open="${id}"`), `${id} trigger not migrated`);
  }
  const opp = read('src/pages/cms/app/crm/opportunities/[opportunityId].astro');
  assert.match(opp, /data-cms-opp-move\s+data-cms-modal-open="cms-opp-move-modal"/);
  assert.match(opp, /data-cms-modal-open="cms-opp-line-modal"/);
});

// ---- The forms still do exactly what they did ------------------------------

test('every modal still submits to the same API it always did', () => {
  const activity = read('src/components/cms/CmsActivitySection.astro');
  assert.match(activity, /fetch\('\/api\/crm\/activities'/);
  const actions = read('src/components/cms/CmsCaseActions.astro');
  assert.match(actions, /\/api\/service\/cases\/\$\{encodeURIComponent\(caseId\)\}\/status/);
  assert.match(actions, /\/api\/service\/cases\/\$\{encodeURIComponent\(caseId\)\}\/assignment/);
  assert.match(
    actions,
    /\/api\/service\/cases\/\$\{encodeURIComponent\(caseId\)\}\/communications/,
  );
});

test('the case triggers keep their permission gates', () => {
  const page = read('src/pages/cms/app/helpdesk/[caseId].astro');
  assert.match(
    page,
    /\{mayManage && allowedMoves\.length > 0 && \(\s*<CmsButton[^>]*data-cms-case-status/s,
  );
  assert.match(page, /\{mayReassign && \(\s*<CmsButton[^>]*data-cms-case-assign/s);
  assert.match(
    page,
    /\{mayManage && \(\s*<div class="mt-3">\s*<CmsButton[^>]*data-cms-case-communicate/s,
  );
});

// ---- Saving states and dirty protection ------------------------------------

test('saving disables the button and says what it is doing', () => {
  const activity = read('src/components/cms/CmsActivitySection.astro');
  assert.match(activity, /busy\(/);
  assert.match(activity, /'Recording…'/);
  const actions = read('src/components/cms/CmsCaseActions.astro');
  assert.match(actions, /'Updating…'/);
  assert.match(actions, /'Assigning…'/);
  assert.match(actions, /'Recording…'/);
  // Restored on every path, so a failed save leaves the modal usable.
  assert.match(activity, /finally \{\s*restore\(\);/);
  assert.match(actions, /finally \{\s*restore\(\);/);
});

test('the typing-heavy forms confirm before a stray close discards them', () => {
  // Add activity, Change status and Record communication carry free-text
  // worth protecting; Assign is two selects and stays prompt-free so the
  // prompt keeps its meaning.
  assert.match(
    read('src/components/cms/CmsActivitySection.astro'),
    /id="cms-activity-modal" title="Add activity" confirmOnDirty/,
  );
  const actions = read('src/components/cms/CmsCaseActions.astro');
  assert.match(actions, /id="cms-case-status-modal" title="Change status" confirmOnDirty/);
  assert.match(actions, /id="cms-case-comm-modal" title="Record communication" confirmOnDirty/);
  assert.ok(!/id="cms-case-assign-modal"[^>]*confirmOnDirty/.test(actions));
  // One confirmation system: the shared script's, keyed off the modal's own
  // data attribute — no component builds a second one.
  assert.match(read('src/components/cms/CmsOverlayScript.astro'), /cmsConfirmDirty/);
});
