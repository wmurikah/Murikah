/**
 * The LPO seal must be deterministic: the same document always yields the same
 * hash, the line order does not matter (lines are sorted by wo_no), and any change
 * to the frozen content changes the hash. The module under test has no relative
 * imports, so node can strip types and run it without the Astro or Cloudflare
 * toolchain. Web Crypto (crypto.subtle) is native in Node 22.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalise, sealHash, reconcile, type SealInput } from '../../src/lib/engr/lpoSeal.ts';

function fixture(): SealInput {
  return {
    lpoNo: 'LPO-2026-0007',
    version: 1,
    contractorId: 'c1',
    baseStationId: 's1',
    regionId: 'r1',
    currency: 'KES',
    subtotalMinor: 300000,
    mileageMinor: 21000,
    totalMinor: 321000,
    issuedAt: '2026-07-03T10:00:00.000Z',
    lines: [
      {
        woNo: 'WO-2026-0002',
        stationName: 'Mombasa Road',
        assetTag: 'DSP-002',
        categoryName: 'Dispensers',
        slaName: 'Standard',
        description: 'Dispenser service',
        amountMinor: 100000,
      },
      {
        woNo: 'WO-2026-0001',
        stationName: 'Nairobi West',
        assetTag: null,
        categoryName: 'Pumps',
        slaName: null,
        description: 'Pump repair',
        amountMinor: 200000,
      },
    ],
  };
}

test('the hash is deterministic for the same document', async () => {
  const a = await sealHash(fixture());
  const b = await sealHash(fixture());
  assert.equal(a, b);
});

test('the hash is stored as sha256:<64 hex>', async () => {
  const h = await sealHash(fixture());
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
});

test('line order does not change the hash (lines are sorted by wo_no)', async () => {
  const forward = fixture();
  const reversed = fixture();
  reversed.lines = [reversed.lines[1], reversed.lines[0]];
  assert.equal(await sealHash(forward), await sealHash(reversed));
  assert.equal(canonicalise(forward), canonicalise(reversed));
});

test('changing a line amount changes the hash', async () => {
  const base = fixture();
  const tampered = fixture();
  tampered.lines[0].amountMinor = 100001;
  assert.notEqual(await sealHash(base), await sealHash(tampered));
});

test('changing the issue timestamp changes the hash', async () => {
  const base = fixture();
  const later = fixture();
  later.issuedAt = '2026-07-03T10:00:00.001Z';
  assert.notEqual(await sealHash(base), await sealHash(later));
});

test('reconcile ties the total to the lines plus mileage', () => {
  const r = reconcile([{ amountMinor: 200000 }, { amountMinor: 100000 }], 21000, 321000);
  assert.equal(r.ok, true);
  assert.equal(r.subtotalMinor, 300000);
  assert.equal(r.expectedTotal, 321000);
});

test('reconcile fails when the total does not tie', () => {
  const r = reconcile([{ amountMinor: 200000 }], 21000, 999999);
  assert.equal(r.ok, false);
  assert.equal(r.subtotalMinor, 200000);
  assert.equal(r.expectedTotal, 221000);
});
