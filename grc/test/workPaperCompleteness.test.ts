/**
 * The completeness gate on submission. The module under test has no relative
 * imports, so node can strip types and run it directly. These pin the two rules
 * the screens rest on: a draft is never held to it, and a submission is refused
 * with everything that is missing named rather than the first thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_FOR_SUBMISSION,
  incompleteMessage,
  isCompleteForSubmission,
  listMissing,
  missingForSubmission,
  type CompletenessSubject,
} from '../../src/lib/grc/workflow/workPaperCompleteness.ts';

const complete: CompletenessSubject = {
  auditAreaId: 'AA-FIN',
  subAreaId: 'SA-TREAS',
  auditPeriodFrom: '2026-01-01',
  auditPeriodTo: '2026-03-31',
  observationTitle: 'Reconciliations not performed',
  observationDescription: 'The monthly reconciliations were not performed.',
  riskRating: 'High',
  recommendation: 'Perform them monthly and review them.',
  assignedAuditorId: 'USR-AUD',
};

test('a finished finding may be submitted', () => {
  assert.deepEqual(missingForSubmission(complete), []);
  assert.equal(isCompleteForSubmission(complete), true);
});

test('an empty finding names every field it needs, in form order', () => {
  assert.deepEqual(missingForSubmission({}), [
    'audit area',
    'sub-area',
    'audit period',
    'observation title',
    'observation description',
    'risk rating',
    'recommendation',
    'assigned auditor',
  ]);
});

test('each required field is required on its own', () => {
  // Removing one field must produce exactly one missing label: a check that
  // happens to pass because another field also failed is a check nobody tested.
  const cases: [keyof CompletenessSubject, string][] = [
    ['auditAreaId', 'audit area'],
    ['subAreaId', 'sub-area'],
    ['observationTitle', 'observation title'],
    ['observationDescription', 'observation description'],
    ['riskRating', 'risk rating'],
    ['recommendation', 'recommendation'],
    ['assignedAuditorId', 'assigned auditor'],
  ];
  for (const [key, label] of cases) {
    assert.deepEqual(missingForSubmission({ ...complete, [key]: null }), [label], key);
  }
});

test('a half-filled period is not a period', () => {
  // One end of a range says nothing about what the fieldwork covered, and
  // naming the missing end rather than the period would be the less useful
  // answer when neither is set.
  assert.deepEqual(missingForSubmission({ ...complete, auditPeriodTo: null }), ['audit period']);
  assert.deepEqual(missingForSubmission({ ...complete, auditPeriodFrom: null }), ['audit period']);
  assert.deepEqual(
    missingForSubmission({ ...complete, auditPeriodFrom: null, auditPeriodTo: null }),
    ['audit period'],
  );
});

test('whitespace is not a value', () => {
  // A form posts '   ' as readily as it posts nothing, and a finding whose
  // recommendation is three spaces is not one a reviewer can read.
  assert.deepEqual(missingForSubmission({ ...complete, recommendation: '   ' }), [
    'recommendation',
  ]);
});

test('the refusal names everything missing, as a sentence', () => {
  assert.equal(listMissing([]), '');
  assert.equal(listMissing(['risk rating']), 'risk rating');
  assert.equal(listMissing(['risk rating', 'recommendation']), 'risk rating and recommendation');
  assert.equal(
    listMissing(['audit area', 'risk rating', 'recommendation']),
    'audit area, risk rating and recommendation',
  );
  assert.equal(
    incompleteMessage(['risk rating', 'recommendation']),
    'Complete risk rating and recommendation before submitting for review.',
  );
});

test('the required set is the reviewable minimum, and nothing else has crept in', () => {
  assert.deepEqual(
    REQUIRED_FOR_SUBMISSION.map((f) => f.label),
    [
      'audit area',
      'sub-area',
      'audit period',
      'observation title',
      'observation description',
      'risk rating',
      'recommendation',
      'assigned auditor',
    ],
  );
});
