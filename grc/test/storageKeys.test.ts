/**
 * Evidence key and hash helpers. The module under test has no imports, so node
 * strips types and runs it directly. These pin the per-tenant key format, the
 * filename safety rules (including path-traversal), the tenant-prefix guard and
 * the sha256 content hash against known vectors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  safeFilename,
  buildObjectKey,
  keyBelongsToOrg,
  orgPrefix,
  sha256Hex,
  CONTENT_HASH_ALGO,
} from '../../src/lib/grc/storage/keys.ts';

test('safeFilename drops any path and keeps a safe segment', () => {
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('C:\\Users\\me\\report.pdf'), 'report.pdf');
  assert.equal(safeFilename(''), 'file');
  assert.equal(safeFilename('....'), 'file');
  const spaced = safeFilename('  My Report (final)!.pdf ');
  assert.ok(!/\s/.test(spaced), 'no whitespace');
  assert.ok(!/^[.-]|[.-]$/.test(spaced), 'no leading or trailing separator');
  assert.ok(/^[A-Za-z0-9._-]+$/.test(spaced), 'only safe characters');
  assert.ok(spaced.includes('.pdf'));
});

test('safeFilename caps the length', () => {
  const long = 'a'.repeat(500) + '.pdf';
  assert.ok(safeFilename(long).length <= 120);
});

test('buildObjectKey uses the per-tenant prefix and is immutable per file', () => {
  const key = buildObjectKey({
    organizationId: 'ORG1',
    entity: 'work_paper',
    entityId: 'WP1',
    fileId: 'F1',
    fileName: 'My Report v2.pdf',
  });
  assert.equal(key, 'org/ORG1/work_paper/WP1/F1/My-Report-v2.pdf');
  assert.ok(key.startsWith(orgPrefix('ORG1')));

  // A replacement is a new file_id, hence a new key: never an overwrite.
  const replacement = buildObjectKey({
    organizationId: 'ORG1',
    entity: 'work_paper',
    entityId: 'WP1',
    fileId: 'F2',
    fileName: 'My Report v2.pdf',
  });
  assert.notEqual(key, replacement);
});

test('keyBelongsToOrg gates a key to its tenant prefix', () => {
  const key = buildObjectKey({
    organizationId: 'ORG1',
    entity: 'work_paper',
    entityId: 'WP1',
    fileId: 'F1',
    fileName: 'a.pdf',
  });
  assert.equal(keyBelongsToOrg(key, 'ORG1'), true);
  assert.equal(keyBelongsToOrg(key, 'ORG2'), false);
  // A crafted key that names another tenant is rejected for the acting tenant.
  assert.equal(keyBelongsToOrg('org/ORG2/work_paper/x/y/a.pdf', 'ORG1'), false);
});

test('sha256Hex matches known vectors', async () => {
  assert.equal(CONTENT_HASH_ALGO, 'sha256');
  const empty = await sha256Hex(new Uint8Array(0));
  assert.equal(empty, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const abc = await sha256Hex(new TextEncoder().encode('abc'));
  assert.equal(abc, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
