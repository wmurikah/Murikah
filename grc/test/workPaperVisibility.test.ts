/**
 * Row-level visibility for the work-paper list (workPaperVisibility.ts, no
 * imports, so node strips types and runs it directly). Pins the viewer model:
 * who sees the whole organisation, who is restricted to their own findings,
 * and who may see foreign drafts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWorkPaperAuditor,
  restrictToOwnFindings,
  seesForeignDrafts,
  type WorkPaperViewer,
} from '../../src/lib/grc/repos/workPaperVisibility.ts';

const viewer = (over: Partial<WorkPaperViewer>): WorkPaperViewer => ({
  userId: 'U1',
  roleCode: 'AUDITOR',
  perms: [],
  isPlatformOwner: false,
  ...over,
});

test('any authoring, review, approve or send grant marks the auditor side', () => {
  for (const perm of [
    'WORK_PAPERS.create',
    'WORK_PAPERS.edit',
    'WORK_PAPERS.review',
    'WORK_PAPERS.approve',
    'WORK_PAPERS.send',
  ]) {
    const v = viewer({ perms: [perm] });
    assert.equal(isWorkPaperAuditor(v), true, perm);
    assert.equal(restrictToOwnFindings(v), false, perm);
  }
});

test('read alone is the auditee side: restricted to assigned or responsible rows', () => {
  const auditee = viewer({ roleCode: 'UNIT_MANAGER', perms: ['WORK_PAPERS.view'] });
  assert.equal(isWorkPaperAuditor(auditee), false);
  assert.equal(restrictToOwnFindings(auditee), true);
  assert.equal(seesForeignDrafts(auditee), false);
});

test('a board role holding only read is restricted like the auditee side', () => {
  const board = viewer({ roleCode: 'BOARD_MEMBER', perms: ['WORK_PAPERS.view', 'REPORTS.view'] });
  assert.equal(restrictToOwnFindings(board), true);
});

test('a platform owner sees everything, foreign drafts included', () => {
  const owner = viewer({ isPlatformOwner: true });
  assert.equal(isWorkPaperAuditor(owner), true);
  assert.equal(restrictToOwnFindings(owner), false);
  assert.equal(seesForeignDrafts(owner), true);
});

test('an ordinary auditor does not see foreign drafts', () => {
  const auditor = viewer({ perms: ['WORK_PAPERS.create', 'WORK_PAPERS.edit'] });
  assert.equal(seesForeignDrafts(auditor), false);
});
