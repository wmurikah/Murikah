/**
 * The inline activity composer: no modal, no reload, nothing lost.
 *
 * Two styles, as ever. The pure pieces — the activity→timeline mapping and
 * the type labels — are tested by calling them. The composer's wiring lives
 * in .astro markup and a component script, so it is pinned by reading the
 * source, the same way modalLifecycle.test.ts pins the dialogs that remain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTIVITY_TYPES } from '../../src/lib/cms/repos/activityAdmin.ts';
import {
  ACTIVITY_VERB,
  activityTimelineEntry,
  activityTypeLabel,
} from '../../src/lib/cms/activityTimeline.ts';

const read = (path: string) => readFileSync(path, 'utf8');
const SECTION = 'src/components/cms/CmsActivitySection.astro';

// ---- No modal, no reload ----------------------------------------------------

test('the composer is inline: no dialog machinery anywhere near it', () => {
  const section = read(SECTION);
  for (const gone of [
    'CmsModal',
    'cms-activity-modal',
    'data-cms-modal-open',
    'showModal',
    '<dialog',
    'window.confirm(',
    'window.alert(',
  ]) {
    assert.ok(!section.includes(gone), `the composer still carries ${gone}`);
  }
  assert.match(section, /data-cms-activity-composer/);
  // The trigger is a real button that says what it is, both ways.
  assert.match(section, /data-cms-activity-toggle/);
  assert.match(section, /aria-expanded/);
  assert.match(section, /'Close' : 'Add activity'/);
});

test('a successful save updates the page instead of reloading it', () => {
  const section = read(SECTION);
  assert.ok(
    !section.includes('window.location.reload'),
    'recording one activity reloads the whole record again',
  );
  // Server-confirmed insertion, in that order: the response row is what gets
  // inserted, and only on response.ok.
  const success = section.slice(
    section.indexOf('if (response.ok)'),
    section.indexOf('const answer'),
  );
  assert.match(success, /await response\.json\(\)/);
  assert.match(success, /insertActivity\(created\)/);
  assert.match(success, /setOpen\(false\)/);
  assert.match(success, /showAck\(\)/);
  // The count and the "showing" note keep telling the truth without a fetch.
  assert.match(section, /countEl\.textContent = String\(total\)/);
  assert.match(section, /Showing the most recent \$\{shown\} of \$\{total\}\./);
  // And the list never grows past the server page size.
  assert.match(section, /if \(shown > cap\)/);
});

test('the client inserts text through textContent, never markup', () => {
  const section = read(SECTION);
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(section));
  assert.match(section, /title\.textContent = entry\.title/);
  // The markup itself is cloned from a CmsTimeline-rendered template, so the
  // browser never re-invents the timeline's HTML.
  assert.match(section, /template\[data-cms-activity-template=/);
  assert.match(read('src/components/cms/CmsTimeline.astro'), /data-timeline-title/);
});

test('the API endpoint is untouched and already returns the created row', () => {
  const api = read('src/pages/cms/api/crm/activities/index.ts');
  assert.match(api, /requireSignedIn\(context\)/);
  assert.match(api, /validateActivity\(await readJson\(context\.request\)\)/);
  assert.match(api, /return result\.ok \? ok\(result\.value\) : failure\(result\)/);
  const section = read(SECTION);
  assert.match(section, /fetch\('\/api\/crm\/activities'/);
  assert.match(section, /method: 'POST'/);
});

// ---- The catalogue: recognition over recall, nothing lost -------------------

test('common and More chips derive from the one canonical catalogue', () => {
  const section = read(SECTION);
  // The five everyday types are the visible chips…
  assert.match(section, /\['CALL', 'EMAIL', 'MEETING', 'NOTE', 'TASK'\]\.filter/);
  // …and BOTH halves are filters over ACTIVITY_TYPES, so no second catalogue
  // exists to drift and no canonical type can be orphaned by a rename.
  assert.match(section, /ACTIVITY_TYPES as readonly string\[\]\)\.includes\(t\)/);
  assert.match(section, /ACTIVITY_TYPES as readonly string\[\]\)\.filter\(\(t\) => !COMMON_TYPES/);
  // Eleven types, all with a verb and a printable label.
  assert.equal(ACTIVITY_TYPES.length, 11);
  for (const type of ACTIVITY_TYPES) {
    assert.ok((ACTIVITY_VERB[type] ?? '').length > 0, `${type} has no timeline verb`);
    assert.ok(activityTypeLabel(type).length > 0, `${type} has no control label`);
  }
  // The names title-casing would misspell are spelled, not re-catalogued.
  assert.equal(activityTypeLabel('WHATSAPP'), 'WhatsApp');
  assert.equal(activityTypeLabel('VISIT'), 'Site visit');
  assert.equal(activityTypeLabel('FOLLOW_UP'), 'Follow-up');
  assert.equal(activityTypeLabel('CALL'), 'Call');
});

test('the submitted vocabulary stays canonical whatever the label says', () => {
  const section = read(SECTION);
  // The radios carry the canonical token as their value; the label is only
  // what a person reads.
  assert.match(section, /name="activityType"\s+value=\{t\}/);
});

// ---- Progressive fields -----------------------------------------------------

test('the type still decides the fields, through the one SHOW mapping', () => {
  const section = read(SECTION);
  assert.match(
    section,
    /CALL: \['contact', 'owner', 'completed', 'completedAt', 'outcome', 'next'\]/,
  );
  assert.match(section, /NOTE: \['notes'\]/, 'a note stays lightweight');
  assert.match(section, /TASK: \['owner', 'scheduledAt', 'notes'\]/);
  // Meeting supports both a past occurrence and a future one.
  const meeting = section.slice(section.indexOf('MEETING: ['), section.indexOf('VISIT: ['));
  assert.match(meeting, /'completed'/);
  assert.match(meeting, /'scheduledAt'/);
});

test('Happened/Scheduled replaces the negative checkbox, and cannot send both stamps', () => {
  const section = read(SECTION);
  assert.ok(!section.includes('Already happened'), 'the negative checkbox wording is back');
  assert.ok(!section.includes('doneBox'), 'the hidden done checkbox is back');
  assert.match(section, /value="happened" checked/);
  assert.match(section, /value="scheduled"/);
  // The mode derives from SHOW — completed-only types are always Happened,
  // scheduled-only types are always Scheduled — and the submit deletes the
  // stamp the mode rules out, so competing timestamps cannot travel together.
  assert.match(section, /if \(!canHappen && !canSchedule\) return 'none'/);
  assert.match(section, /if \(mode === 'happened'\) \{\s*delete body\.scheduledAt;/);
  assert.match(section, /} else if \(mode === 'scheduled'\) \{\s*delete body\.completedAt;/);
  // A task or follow-up never gets stamped completed at birth: the scheduled
  // branch strips completedAt, where the old checkbox quietly added it and
  // kept every new task out of My Work's open lists.
  assert.match(section, /never stamps a completion/);
});

test('Happened defaults to Now, with the picker one deliberate Change away', () => {
  const section = read(SECTION);
  assert.match(section, /data-act-when-change/);
  assert.match(section, /data-act-completed-wrap hidden/);
  // Left on Now, the submit stamps the current local time exactly as before.
  assert.match(section, /if \(!\('completedAt' in body\)\)/);
});

test('secondary fields wait under More details; assignment types keep Owner visible', () => {
  const section = read(SECTION);
  assert.match(section, /data-act-more-details/);
  assert.match(section, />\s*More details\s*</);
  // Owner surfaces for TASK and FOLLOW_UP, notes surface for NOTE; both move
  // as nodes, so typed values survive the move.
  assert.match(section, /type === 'TASK' \|\| type === 'FOLLOW_UP'/);
  assert.match(section, /assignment \? ownerSlot : moreBody/);
  assert.match(section, /type === 'NOTE'\) notesSlot/);
});

// ---- The one activity→timeline mapping --------------------------------------

test('a completed call reads exactly as the server would have rendered it', () => {
  const entry = activityTimelineEntry(
    {
      entityType: 'LEAD',
      entityId: 'LEAD-9',
      activityType: 'CALL',
      summary: 'Discussed August fuel order',
      contactName: 'Amina Yusuf',
      outcome: 'Order confirmed',
      nextAction: 'Send quotation',
      nextActionDue: '2026-09-03 09:00:00',
      scheduledAt: null,
      completedAt: '2026-09-01 11:30:00',
      createdAt: '2026-09-01 11:31:00',
      dueAt: '2026-09-03 09:00:00',
      ownerName: 'Catherine W.',
    },
    false,
  );
  assert.equal(entry.title, 'Recorded call: Discussed August fuel order');
  assert.equal(
    entry.detail,
    'With Amina Yusuf · Outcome: Order confirmed · Next: Send quotation by 2026-09-03 09:00:00',
  );
  assert.equal(entry.actor, 'Catherine W.');
  assert.equal(entry.timestamp, '2026-09-01T11:30:00');
  assert.equal(entry.tone, 'default');
});

test('an open task is marked pending, with its due time on show', () => {
  const entry = activityTimelineEntry(
    {
      entityType: 'ACCOUNT',
      entityId: 'ACC-1',
      activityType: 'TASK',
      summary: 'Send revised quotation',
      contactName: null,
      outcome: null,
      nextAction: null,
      nextActionDue: null,
      scheduledAt: '2026-09-05 10:00:00',
      completedAt: null,
      createdAt: '2026-09-01 08:00:00',
      dueAt: '2026-09-05 10:00:00',
      ownerName: 'Catherine W.',
    },
    false,
  );
  assert.equal(entry.title, 'Task: Send revised quotation');
  assert.equal(entry.detail, 'Due 2026-09-05 10:00:00');
  assert.equal(entry.tone, 'warning');
  assert.equal(entry.timestamp, '2026-09-05T10:00:00');
});

test('the account timeline still names the record an activity came through', () => {
  const entry = activityTimelineEntry(
    {
      entityType: 'SALES_ORDER',
      entityId: 'SO-77',
      activityType: 'NOTE',
      summary: 'Left gate pass at reception',
      contactName: null,
      outcome: null,
      nextAction: null,
      nextActionDue: null,
      scheduledAt: null,
      completedAt: '2026-09-01 12:00:00',
      createdAt: '2026-09-01 12:00:00',
      dueAt: null,
      ownerName: 'Catherine W.',
    },
    true,
  );
  assert.equal(entry.detail, 'On sales order SO-77');
});

test('the server render and the client insert share the mapping', () => {
  const section = read(SECTION);
  // Frontmatter maps with it and the script imports the SAME function; the
  // component holds no verb table or tone rule of its own.
  assert.equal(
    (section.match(/activityTimelineEntry\(/g) ?? []).length >= 2,
    true,
    'both renderers must call the shared mapping',
  );
  assert.ok(!/const VERB|Recorded call/.test(section), 'a private verb table is back');
});

// ---- Dirty state and failure ------------------------------------------------

test('a dirty close asks inline; a clean one just closes', () => {
  const section = read(SECTION);
  assert.match(section, /if \(dirty\) showDiscard\(true\);\s*else setOpen\(false\)/);
  assert.match(section, /Discard this activity\?/);
  assert.match(section, /data-cms-activity-keep/);
  assert.match(section, /data-cms-activity-discard-confirm/);
  // Choosing a type chip loses no typing, so it does not arm the prompt.
  assert.match(section, /name === 'activityType' \|\| target\?\.name === 'act-when-mode'\) return/);
  // Escape goes through the same gate, from a listener scoped to the
  // composer — no focus trap, no document-wide key handling.
  assert.match(section, /composer\?\.addEventListener\('keydown'/);
  assert.match(section, /event\.key === 'Escape' && !composer\.hidden\) requestClose\(\)/);
});

test('a failed save keeps the composer open with everything typed still there', () => {
  const section = read(SECTION);
  const failure = section.slice(section.indexOf('const answer'), section.indexOf('} finally'));
  assert.ok(!failure.includes('setOpen'), 'a failure must not collapse the composer');
  assert.ok(!failure.includes('form.reset'), 'a failure must not clear the form');
  assert.match(failure, /errorBox\.textContent/);
  assert.match(failure, /Couldn’t record activity/);
  // The button always comes back: busy() restored in finally.
  assert.match(section, /busy\(/);
  assert.match(section, /'Recording…'/);
  assert.match(section, /finally \{\s*restore\(\);/);
});

// ---- Reuse ------------------------------------------------------------------

test('one composer serves the account, lead, opportunity and case pages', () => {
  for (const page of [
    'src/pages/cms/app/customers/[accountId].astro',
    'src/pages/cms/app/operations/customers/[accountId].astro',
    'src/pages/cms/app/crm/[leadId].astro',
    'src/pages/cms/app/crm/opportunities/[opportunityId].astro',
    'src/pages/cms/app/helpdesk/[caseId].astro',
  ]) {
    const source = read(page);
    assert.match(source, /<CmsActivitySection/, `${page} lost the shared activity section`);
    assert.ok(!source.includes('cms-activity-form'), `${page} grew a private composer of its own`);
  }
});
