import assert from 'node:assert/strict';
import test from 'node:test';
import { blockSeconds } from '../src/lib/engr/auth/loginSecurity.ts';
import { SESSION_IDLE_SECONDS } from '../src/lib/engr/auth/trackedSession.ts';

test('login backoff starts at five failures and remains bounded', () => {
  assert.equal(blockSeconds(4), 0);
  assert.equal(blockSeconds(5), 60);
  assert.equal(blockSeconds(6), 120);
  assert.equal(blockSeconds(100), 1800);
});

test('privileged sessions have the shortest application idle lifetime', () => {
  assert.equal(SESSION_IDLE_SECONDS.PRIVILEGED, 15 * 60);
  assert.equal(SESSION_IDLE_SECONDS.RESTRICTED, 10 * 60);
  assert.equal(SESSION_IDLE_SECONDS.STANDARD, 2 * 60 * 60);
});
