/**
 * The evidence upload's feedback, tested directly (Build Prompt 66).
 *
 * The panel used to say "Uploading <file>..." for ever, because the browser's
 * PUT to the organisation's bucket was refused before it began and nothing
 * turned that rejection into a message. The module under test is what the panel
 * now says instead, and it is pure and import-free precisely so these
 * assertions run against the real strings rather than a copy of them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UPLOAD_STALL_MS,
  UPLOAD_TAG,
  classifyUploadFailure,
  formatBytes,
  isCrossOrigin,
  uploadFailureMessage,
  uploadLogLine,
  uploadPercent,
} from '../../src/lib/grc/storage/uploadFeedback.ts';

const ORIGIN = 'https://grc.murikah.com';

test('a size reads the way the file manager showed it', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(940), '940 B');
  assert.equal(formatBytes(2_400_000), '2.4 MB');
  assert.equal(formatBytes(240_000_000), '240 MB');
  assert.equal(formatBytes(1_500), '1.5 kB');
  assert.equal(formatBytes(3_100_000_000), '3.1 GB');
});

test('a size that is not a size says nothing rather than NaN', () => {
  assert.equal(formatBytes(Number.NaN), '');
  assert.equal(formatBytes(-1), '');
});

test('percent complete comes from the bytes, and never leaves 0 to 100', () => {
  assert.equal(uploadPercent(0, 1000), 0);
  assert.equal(uploadPercent(425, 1000), 42);
  assert.equal(uploadPercent(1000, 1000), 100);
  // A total the browser could not compute must not become a fake bar.
  assert.equal(uploadPercent(500, 0), 0);
  // Nor may a browser reporting more sent than there is push it past the end.
  assert.equal(uploadPercent(1200, 1000), 100);
});

test('a cross-origin upload is told apart from this site is own', () => {
  assert.equal(isCrossOrigin('https://acc.r2.cloudflarestorage.com/b/k', ORIGIN), true);
  assert.equal(isCrossOrigin('/api/evidence/put', ORIGIN), false);
  assert.equal(isCrossOrigin(`${ORIGIN}/api/evidence/put`, ORIGIN), false);
});

test('no response on a cross-origin PUT is the bucket refusing the browser', () => {
  // This is the live failure: the bucket has no cross-origin rule for the site,
  // so the browser is refused before the request is made and there is no status
  // to read. It has a specific cure, so it must not be lumped in with a dead
  // network.
  assert.equal(classifyUploadFailure({ status: 0, crossOrigin: true }), 'blocked');
  assert.equal(classifyUploadFailure({ status: 0, crossOrigin: false }), 'unreachable');
});

test('a status that did come back is a refusal, and silence is a stall', () => {
  assert.equal(classifyUploadFailure({ status: 403, crossOrigin: true }), 'refused');
  assert.equal(classifyUploadFailure({ status: 500, crossOrigin: false }), 'refused');
  assert.equal(classifyUploadFailure({ status: 0, timedOut: true, crossOrigin: true }), 'stalled');
  // Cancelling is not a fault, and must not be reported as one.
  assert.equal(classifyUploadFailure({ status: 0, aborted: true, crossOrigin: true }), 'aborted');
});

test('the blocked message names the cure, not just the symptom', () => {
  const message = uploadFailureMessage({
    kind: 'blocked',
    status: 0,
    fileName: 'march-reconciliation.pdf',
    origin: ORIGIN,
  });
  assert.match(message, /march-reconciliation\.pdf/);
  assert.match(message, /PUT and GET/);
  assert.ok(message.includes(ORIGIN), 'the origin the bucket has to allow');
  assert.match(message, /administrator/, 'and who can do something about it');
});

test('every ending has words of its own, and none of them is a hang', () => {
  const of = (kind: Parameters<typeof uploadFailureMessage>[0]['kind'], status = 0): string =>
    uploadFailureMessage({ kind, status, fileName: 'scan.pdf', origin: ORIGIN });
  const said = [of('blocked'), of('unreachable'), of('stalled'), of('aborted'), of('refused', 403)];
  for (const message of said) {
    assert.ok(message.startsWith('scan.pdf'), `each names the file, got ${message}`);
    assert.ok(message.length > 20, 'and says something');
  }
  assert.equal(new Set(said).size, said.length, 'and no two failures read the same');
  assert.match(of('refused', 403), /403/, 'a real status is quoted, because it is the clue');
  assert.match(of('stalled'), new RegExp(String(Math.round(UPLOAD_STALL_MS / 1000))));
});

test('the log line carries the status an operator has to search for', () => {
  const line = uploadLogLine({
    kind: 'blocked',
    status: 0,
    fileName: 'scan.pdf',
    origin: ORIGIN,
    url: 'https://acc.r2.cloudflarestorage.com/bucket/org/ORG-1/work_paper/WP-1/f/scan.pdf',
  });
  assert.ok(line.startsWith(`${UPLOAD_TAG} blocked `), `tagged and named, got ${line}`);
  const payload = JSON.parse(line.slice(`${UPLOAD_TAG} blocked `.length)) as Record<
    string,
    unknown
  >;
  assert.equal(payload.status, 0);
  assert.equal(payload.file_name, 'scan.pdf');
  assert.equal(payload.origin, ORIGIN);
});

test('the stall allowance is long enough for a slow depot and short enough to notice', () => {
  // It is armed on each progress event, so it only ever fires on silence; a
  // legitimately slow transfer keeps resetting it.
  assert.ok(UPLOAD_STALL_MS >= 10_000, 'a slow first chunk must not be killed');
  assert.ok(UPLOAD_STALL_MS <= 60_000, 'and nobody should watch a dead bar for a minute');
});
