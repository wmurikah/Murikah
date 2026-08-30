/**
 * The post-sign-in destination (Build Prompt 53). The digest email links a
 * reviewer at the review queue, and the guard carries that destination through
 * sign-in, so this function reads an attacker-controllable parameter. Its whole
 * job is refusing everything that is not a path inside this app, which is why
 * it is one pure function with its own tests rather than three inline checks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNextPath } from '../../src/lib/grc/routing.ts';

test('a root-relative app path is returned, query and all', () => {
  assert.equal(safeNextPath('/work-papers?status=Submitted'), '/work-papers?status=Submitted');
  assert.equal(safeNextPath('/work-papers/WP-1'), '/work-papers/WP-1');
  assert.equal(safeNextPath('/settings/storage'), '/settings/storage');
});

test('anything that could leave this origin is refused', () => {
  for (const hostile of [
    'https://evil.example/steal',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'data:text/html,<script>',
    'work-papers',
    '',
    '   ',
  ]) {
    assert.equal(safeNextPath(hostile), null, `${JSON.stringify(hostile)} must not be trusted`);
  }
});

test('a header-splitting attempt is refused', () => {
  assert.equal(safeNextPath('/work-papers\r\nSet-Cookie: a=b'), null);
  assert.equal(safeNextPath('/work-papers with a space'), null);
  assert.equal(safeNextPath(`/${'a'.repeat(600)}`), null);
});

test('a public path is refused, so no sign-in loop can be built', () => {
  assert.equal(safeNextPath('/login'), null);
  assert.equal(safeNextPath('/login?next=/login'), null);
  assert.equal(safeNextPath('/forgot-password'), null);
});

test('a non-string is refused rather than coerced', () => {
  assert.equal(safeNextPath(undefined), null);
  assert.equal(safeNextPath(null), null);
  assert.equal(safeNextPath(42), null);
});
