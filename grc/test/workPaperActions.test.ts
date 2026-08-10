/**
 * The work-paper action catalogue. The module under test has no relative
 * imports, so node can strip types and run it directly. These pin the mapping
 * the workflow executor relies on: each target status maps to the right
 * WORK_PAPERS.* permission and dated attribution, the send action carries the
 * confirmed finding_shared template, and only Draft and Revision Required are
 * editable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WP_STATUS,
  WORK_PAPER_ENUM_TYPE,
  actionForTarget,
  grantForTransition,
  isEditable,
  editableStatuses,
} from '../../src/lib/grc/workflow/workPaperActions.ts';

test('the enum type is the work-paper status type', () => {
  assert.equal(WORK_PAPER_ENUM_TYPE, 'WORK_PAPER_STATUS');
});

test('each action maps to the matrix grant an administrator can see', () => {
  // The grants are matrix cells, not derived WORK_PAPERS.* strings (Build
  // Prompt 55): submitting follows the authoring grant an auditor holds, and
  // the reviewer steps follow approve, which auditors correctly lack.
  assert.deepEqual(actionForTarget(WP_STATUS.SUBMITTED)?.grant, {
    module: 'WORK_PAPER',
    action: 'update',
  });
  for (const reviewerStep of [
    WP_STATUS.UNDER_REVIEW,
    WP_STATUS.REVISION_REQUIRED,
    WP_STATUS.APPROVED,
    WP_STATUS.SENT_TO_AUDITEE,
  ]) {
    assert.deepEqual(
      actionForTarget(reviewerStep)?.grant,
      { module: 'WORK_PAPER', action: 'approve' },
      `${reviewerStep} is the reviewer's`,
    );
  }
  assert.equal(actionForTarget('NOT_A_STATUS'), null);
});

test('the grant follows the move, not the status it lands on', () => {
  // Build Prompt 56. Both ways into Submitted are the auditor's own release, so
  // both ask for the grant an auditor holds; the reviewer's verdict and the
  // release to the auditee keep approve, which an auditor correctly lacks.
  const update = { module: 'WORK_PAPER', action: 'update' };
  const approve = { module: 'WORK_PAPER', action: 'approve' };
  assert.deepEqual(grantForTransition(WP_STATUS.DRAFT, WP_STATUS.SUBMITTED), update);
  assert.deepEqual(grantForTransition(WP_STATUS.REVISION_REQUIRED, WP_STATUS.SUBMITTED), update);
  assert.deepEqual(grantForTransition(WP_STATUS.UNDER_REVIEW, WP_STATUS.APPROVED), approve);
  assert.deepEqual(
    grantForTransition(WP_STATUS.UNDER_REVIEW, WP_STATUS.REVISION_REQUIRED),
    approve,
  );
  assert.deepEqual(grantForTransition(WP_STATUS.APPROVED, WP_STATUS.SENT_TO_AUDITEE), approve);
});

test('a move the mapping does not name falls back to its target', () => {
  // Starting a review is the reviewer's, through the catalogue entry for the
  // status it reaches; a target this application cannot act on has no grant at
  // all, so nothing is silently ungated.
  assert.deepEqual(grantForTransition(WP_STATUS.SUBMITTED, WP_STATUS.UNDER_REVIEW), {
    module: 'WORK_PAPER',
    action: 'approve',
  });
  assert.equal(grantForTransition(WP_STATUS.DRAFT, 'NOT_A_STATUS'), null);
});

test('a hand-edited transition row still resolves its grant', () => {
  assert.deepEqual(grantForTransition(' draft ', 'SUBMITTED'), {
    module: 'WORK_PAPER',
    action: 'update',
  });
});

test('submitting is the only authoring step', () => {
  assert.equal(actionForTarget(WP_STATUS.SUBMITTED)?.authoring, true);
  for (const reviewerStep of [WP_STATUS.APPROVED, WP_STATUS.REVISION_REQUIRED]) {
    assert.ok(!actionForTarget(reviewerStep)?.authoring, `${reviewerStep} is not authoring`);
  }
});

test('a hand-edited status still matches its action', () => {
  // status_transitions is operator-managed, and a trailing space or a different
  // capitalisation is invisible on every screen that shows it.
  assert.equal(actionForTarget(' Submitted ')?.label, 'Submit for review');
  assert.equal(actionForTarget('submitted')?.label, 'Submit for review');
  assert.equal(actionForTarget('  ')?.label, undefined);
});

test('submit and send stamp only their dated attribution', () => {
  // The hassaudit schema has only a date column for these two steps.
  assert.deepEqual(actionForTarget(WP_STATUS.SUBMITTED)?.attribution, {
    date: 'submitted_date',
  });
  assert.deepEqual(actionForTarget(WP_STATUS.SENT_TO_AUDITEE)?.attribution, {
    date: 'sent_to_auditee_date',
  });
});

test('approve records the approver id and name and the date', () => {
  assert.deepEqual(actionForTarget(WP_STATUS.APPROVED)?.attribution, {
    byId: 'approved_by_id',
    byName: 'approved_by_name',
    date: 'approved_date',
  });
});

test('request revision records the reviewer, the date and their comments', () => {
  const meta = actionForTarget(WP_STATUS.REVISION_REQUIRED);
  assert.equal(meta?.attribution?.byId, 'reviewed_by_id');
  assert.equal(meta?.attribution?.date, 'review_date');
  assert.equal(meta?.attribution?.comments, 'review_comments');
});

test('the send action carries the confirmed finding_shared template', () => {
  assert.equal(actionForTarget(WP_STATUS.SENT_TO_AUDITEE)?.notifyTemplate, 'finding_shared');
});

test('only Draft and Revision Required are editable', () => {
  assert.equal(isEditable(WP_STATUS.DRAFT), true);
  assert.equal(isEditable(WP_STATUS.REVISION_REQUIRED), true);
  assert.equal(isEditable(WP_STATUS.SUBMITTED), false);
  assert.equal(isEditable(WP_STATUS.APPROVED), false);
  assert.deepEqual([...editableStatuses()], [WP_STATUS.DRAFT, WP_STATUS.REVISION_REQUIRED]);
});
