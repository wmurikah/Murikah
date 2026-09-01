/**
 * Build Prompt 42, the parsing rule: the extract filename read strictly, as a
 * claim. Sixteen well-formed names a month must all parse; everything else
 * must yield nothing at all — no crash, no guess, no first-two-letters — so
 * the upload falls back to the operator choosing exactly as it did before
 * this phase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseExtractFilename,
  checkClaimedPeriod,
  EXTRACT_PROCESS_FOR_IMPORT,
} from '../../src/lib/cms/import/extractName.ts';

const TOKENS = ['KE', 'UG', 'TZ', 'RW', 'ZM', 'DRC', 'SSD', 'TERMINAL'];

test('all sixteen monthly filename shapes parse into process, entity and two dates', () => {
  for (const process of ['SALES', 'PURCHASE'] as const) {
    for (const token of TOKENS) {
      const name = `${process}-${token}-01AUG2026-24AUG2026.xls`;
      const claim = parseExtractFilename(name);
      assert.ok(claim !== null, `${name} must parse`);
      assert.equal(claim.process, process);
      assert.equal(claim.entityToken, token);
      assert.equal(claim.periodFrom, '2026-08-01');
      assert.equal(claim.periodTo, '2026-08-24');
    }
  }
  // Both container extensions, and only the extension is case-forgiving.
  assert.ok(parseExtractFilename('SALES-KE-01AUG2026-24AUG2026.xlsx') !== null);
  assert.ok(parseExtractFilename('SALES-KE-01AUG2026-24AUG2026.XLS') !== null);
});

test('every month token reads as its calendar month', () => {
  const months = [
    ['JAN', '01'],
    ['FEB', '02'],
    ['MAR', '03'],
    ['APR', '04'],
    ['MAY', '05'],
    ['JUN', '06'],
    ['JUL', '07'],
    ['AUG', '08'],
    ['SEP', '09'],
    ['OCT', '10'],
    ['NOV', '11'],
    ['DEC', '12'],
  ] as const;
  for (const [token, number] of months) {
    const claim = parseExtractFilename(`SALES-KE-05${token}2026-06${token}2026.xls`);
    assert.equal(claim?.periodFrom, `2026-${number}-05`);
  }
});

test('a malformed name yields nothing: no crash, no guess, operator chooses', () => {
  const malformed = [
    // The three shapes the acceptance asks to be shown, and their reasons.
    'SalesReport-KE-Aug.xls', // not the shape at all
    'SALES-KE-2026AUG01-24AUG2026.xls', // dates in the wrong order of parts
    'SALES--01AUG2026-24AUG2026.xls', // an empty entity token
    // And the near-misses strictness exists for.
    'sales-ke-01aug2026-24aug2026.xls', // lowercase is not the extract's shape
    'SALES-KE-31FEB2026-24MAR2026.xls', // an impossible calendar date
    'SALES-KE-24AUG2026-01AUG2026.xls', // a period that ends before it starts
    'SALES-KE-01AUG2026-24AUG2026.csv', // not a workbook extension
    'PO-Ver1.xls', // the historical name, untouched by this phase
    'SALES-KE-01AUG2026.xls', // one date is not a period
  ];
  for (const name of malformed) {
    assert.equal(parseExtractFilename(name), null, `${name} must not half-parse`);
  }
});

test('the process token maps one-to-one onto the import types', () => {
  assert.equal(EXTRACT_PROCESS_FOR_IMPORT.SALES_ORDER, 'SALES');
  assert.equal(EXTRACT_PROCESS_FOR_IMPORT.PURCHASE_ORDER, 'PURCHASE');
});

test('the period cross-check agrees quietly and differs loudly, and never overrides', () => {
  const claim = parseExtractFilename('PURCHASE-UG-01AUG2026-24AUG2026.xls');
  assert.ok(claim !== null);
  // Data inside the named window: agreement, said plainly.
  const agrees = checkClaimedPeriod(claim, '2026-08-03 09:00', '2026-08-20 17:30');
  assert.equal(agrees.status, 'agrees');
  // The acceptance's own example: the name says August, the data is May.
  const differs = checkClaimedPeriod(claim, '2026-04-30 08:00', '2026-05-30 16:00');
  assert.equal(differs.status, 'differs');
  assert.match(differs.detail, /2026-08-01 to 2026-08-24/);
  assert.match(differs.detail, /2026-04-30 to 2026-05-30/);
  assert.match(differs.detail, /The data is what is in the file/);
  // No dated rows: nothing to check, and it says so instead of pretending.
  assert.equal(checkClaimedPeriod(claim, null, null).status, 'unchecked');
});
