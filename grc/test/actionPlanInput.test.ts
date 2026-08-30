/**
 * The pure action-plan input parsing and the Kanban return-to guard.
 *
 * The date pairing matters: the overdue job measures against due_date while the
 * form leads with the agreed target_date, so a plan captured with only one of
 * them must still be measurable. The return-to guard is a security boundary: a
 * dropped Kanban card sends the board it came from, and anything else must fall
 * back to the plan's own detail rather than become an open redirect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseActionPlanInput,
  checkActionPlanInput,
  safeReturnPath,
  PRIORITIES,
} from '../../src/lib/grc/repos/actionPlanInput.ts';

/** The transition endpoint's binding of the shared guard. */
const safeReturnTo = (raw: string | null, id: string): string =>
  safeReturnPath(raw, '/action-plans', `/action-plans/${id}`);

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

test('the target date falls back to the due date, and the due date to the target', () => {
  const onlyDue = parseActionPlanInput(form({ action_description: 'a', due_date: '2026-03-01' }));
  assert.equal(onlyDue.targetDate, '2026-03-01');
  assert.equal(onlyDue.dueDate, '2026-03-01');

  const onlyTarget = parseActionPlanInput(
    form({ action_description: 'a', target_date: '2026-04-01' }),
  );
  assert.equal(onlyTarget.targetDate, '2026-04-01');
  assert.equal(onlyTarget.dueDate, '2026-04-01');

  const both = parseActionPlanInput(
    form({ action_description: 'a', target_date: '2026-04-01', due_date: '2026-05-01' }),
  );
  assert.equal(both.targetDate, '2026-04-01');
  assert.equal(both.dueDate, '2026-05-01');
});

test('blank fields become null rather than empty strings', () => {
  const input = parseActionPlanInput(
    form({ action_description: '  Fix it  ', priority: '', implementation_notes: '   ' }),
  );
  assert.equal(input.actionDescription, 'Fix it');
  assert.equal(input.priority, null);
  assert.equal(input.implementationNotes, null);
  assert.equal(input.targetDate, null);
  assert.equal(input.dueDate, null);
});

test('the parent observation is required: no description, no parent, no plan', () => {
  const linked = parseActionPlanInput(
    form({ action_description: 'Reconcile monthly.', work_paper_id: 'WP-1' }),
  );
  assert.equal(checkActionPlanInput(linked), null);
  const noParent = parseActionPlanInput(form({ action_description: 'Reconcile monthly.' }));
  assert.match(String(checkActionPlanInput(noParent)), /parent observation/);
  // A blank selection is the same as none.
  const blankParent = parseActionPlanInput(
    form({ action_description: 'Reconcile monthly.', work_paper_id: '   ' }),
  );
  assert.match(String(checkActionPlanInput(blankParent)), /parent observation/);
  const noDescription = parseActionPlanInput(form({ work_paper_id: 'WP-1' }));
  assert.match(String(checkActionPlanInput(noDescription)), /description/);
});

test('the priority vocabulary runs most to least severe', () => {
  assert.deepEqual([...PRIORITIES], ['Critical', 'High', 'Medium', 'Low']);
});

test('a Kanban return-to is honoured only for root-relative action-plan paths', () => {
  const id = 'AP-1';
  assert.equal(safeReturnTo('/action-plans?view=kanban', id), '/action-plans?view=kanban');
  assert.equal(safeReturnTo('/action-plans/AP-2', id), '/action-plans/AP-2');
  // Anything else falls back to the plan's detail.
  assert.equal(safeReturnTo(null, id), '/action-plans/AP-1');
  assert.equal(safeReturnTo('', id), '/action-plans/AP-1');
  assert.equal(safeReturnTo('/settings/users', id), '/action-plans/AP-1');
  assert.equal(safeReturnTo('/action-plans-evil', id), '/action-plans/AP-1');
});

test('the return-to guard refuses off-site redirects', () => {
  const id = 'AP-1';
  for (const hostile of [
    '//evil.example/action-plans',
    'https://evil.example/action-plans',
    'http://evil.example',
    'javascript:alert(1)',
    '/\\evil.example',
  ]) {
    assert.equal(
      safeReturnTo(hostile, id),
      '/action-plans/AP-1',
      `${hostile} must not survive the guard`,
    );
  }
});
