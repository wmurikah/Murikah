/**
 * R2 SigV4 presigning. The module under test imports only types, so node strips
 * types and runs it directly. AWS presign vectors are awkward to pin exactly, so
 * these assert the canonical structure, determinism, and that the signature is
 * sensitive to the key and the method (never a shared or reusable signature).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presignR2Url } from '../../src/lib/grc/storage/sigv4.ts';

const NOW = new Date('2026-07-05T03:00:00.000Z');
const base = {
  accountId: 'acc',
  bucket: 'evidence',
  key: 'org/ORG1/work_paper/WP1/F1/a.pdf',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
  expiresInSeconds: 900,
  now: NOW,
} as const;

test('presignR2Url builds a well-formed, path-style SigV4 URL', async () => {
  const url = await presignR2Url({ method: 'PUT', ...base });
  assert.ok(
    url.startsWith(
      'https://acc.r2.cloudflarestorage.com/evidence/org/ORG1/work_paper/WP1/F1/a.pdf?',
    ),
    'path-style host and key',
  );
  assert.match(url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/);
  assert.match(url, /X-Amz-Credential=AKID%2F20260705%2Fauto%2Fs3%2Faws4_request/);
  assert.match(url, /X-Amz-Date=20260705T030000Z/);
  assert.match(url, /X-Amz-Expires=900/);
  assert.match(url, /X-Amz-SignedHeaders=host/);
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}/);
});

test('only the host is signed, so the browser may set its own content type', async () => {
  // The upload is a browser PUT that carries the file's content type. Because
  // the signature covers the host and nothing else, that header cannot
  // invalidate the URL. It does make the request non-simple, so the browser
  // sends a preflight first, which is why the bucket needs a CORS rule allowing
  // PUT and the content-type header (grc/docs/storage-setup.md). That is
  // configuration, not signing, and this asserts the signing half of it.
  const url = await presignR2Url({ method: 'PUT', ...base });
  assert.match(url, /X-Amz-SignedHeaders=host(&|$)/, 'host, and only host');
  assert.ok(!/content-type/i.test(url), 'no content type is signed into the URL');
});

test('presignR2Url is deterministic for the same inputs', async () => {
  const a = await presignR2Url({ method: 'GET', ...base });
  const b = await presignR2Url({ method: 'GET', ...base });
  assert.equal(a, b);
});

test('the signature depends on the key and the method', async () => {
  const sig = (u: string): string => u.split('X-Amz-Signature=')[1];
  const put = await presignR2Url({ method: 'PUT', ...base });
  const get = await presignR2Url({ method: 'GET', ...base });
  const otherKey = await presignR2Url({
    method: 'PUT',
    ...base,
    key: 'org/ORG1/work_paper/WP1/F2/a.pdf',
  });
  assert.notEqual(sig(put), sig(get));
  assert.notEqual(sig(put), sig(otherKey));
});
