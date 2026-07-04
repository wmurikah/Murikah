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
  isEditable,
  editableStatuses,
} from '../../src/lib/grc/workflow/workPaperActions.ts';

test('the enum type is the work-paper status type', () => {
  assert.equal(WORK_PAPER_ENUM_TYPE, 'WORK_PAPER_STATUS');
});

test('each action maps to its WORK_PAPERS permission', () => {
  assert.equal(actionForTarget(WP_STATUS.SUBMITTED)?.permission, 'WORK_PAPERS.submit');
  assert.equal(actionForTarget(WP_STATUS.REVISION_REQUIRED)?.permission, 'WORK_PAPERS.review');
  assert.equal(actionForTarget(WP_STATUS.APPROVED)?.permission, 'WORK_PAPERS.approve');
  assert.equal(actionForTarget(WP_STATUS.SENT_TO_AUDITEE)?.permission, 'WORK_PAPERS.send');
  assert.equal(actionForTarget('NOT_A_STATUS'), null);
});

test('submit, approve and send stamp their dated attribution', () => {
  assert.deepEqual(actionForTarget(WP_STATUS.SUBMITTED)?.attribution, {
    by: 'submitted_by',
    at: 'submitted_at',
  });
  assert.deepEqual(actionForTarget(WP_STATUS.APPROVED)?.attribution, {
    by: 'approved_by',
    at: 'approved_at',
  });
  assert.equal(actionForTarget(WP_STATUS.SENT_TO_AUDITEE)?.attribution?.at, 'sent_to_auditee_at');
});

test('request revision records the reviewer and their comments', () => {
  const meta = actionForTarget(WP_STATUS.REVISION_REQUIRED);
  assert.equal(meta?.attribution?.by, 'reviewed_by');
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
