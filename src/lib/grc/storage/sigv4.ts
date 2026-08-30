/**
 * AWS Signature Version 4 query-string ("presigned URL") signing for the
 * Cloudflare R2 S3-compatible API, using Web Crypto only so it runs in the
 * Worker. No first-party value imports (types only), so node strips types and
 * unit-tests this directly.
 *
 * R2 is addressed path-style at https://{accountId}.r2.cloudflarestorage.com,
 * region 'auto', service 's3'. The presigned URL signs only the host header and
 * an UNSIGNED-PAYLOAD, so the large object bytes flow straight between the client
 * and R2 and never through the Worker.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const REGION = 'auto';
const SERVICE = 's3';

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Copy a view into a fresh ArrayBuffer, so Web Crypto sees an unambiguous BufferSource. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

function utf8(msg: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(msg));
}

/** Encode per RFC 3986 as AWS SigV4 requires, optionally preserving the slash. */
function awsUriEncode(input: string, encodeSlash: boolean): string {
  const encoded = encodeURIComponent(input).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return encodeSlash ? encoded : encoded.replace(/%2F/g, '/');
}

async function sha256HexOfString(msg: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8(msg));
  return toHex(digest);
}

async function hmac(key: ArrayBuffer, msg: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, utf8(msg));
}

async function signingKey(secretAccessKey: string, dateStamp: string): Promise<ArrayBuffer> {
  const kDate = await hmac(utf8(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

export interface R2PresignParams {
  /**
   * The HTTP method the URL is signed for. SigV4 signs the method, so a URL
   * signed for PUT cannot be used to DELETE: each verb needs its own signature.
   * HEAD and DELETE are here for the server-side probe and the governed removal.
   */
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  accountId: string;
  bucket: string;
  /** The object key, already tenant-scoped by the caller. */
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds: number;
  /** The signing instant; passed in so the result is deterministic and testable. */
  now: Date;
  /**
   * The S3 origin to sign against, when the customer's account is not reached
   * at the default `<account>.r2.cloudflarestorage.com`. This is the Endpoint
   * field the settings screen has always offered and, until now, never used:
   * an S3-compatible endpoint is exactly what makes an R2 connection testable
   * against something other than Cloudflare (Build Prompt 54).
   *
   * SigV4 signs the host header, so the override has to reach the signature
   * rather than being swapped into the URL afterwards; a URL signed for one
   * host and sent to another is refused.
   */
  endpoint?: string;
}

/**
 * The origin and host to sign for: the configured endpoint when there is one,
 * else the account's own R2 origin. A malformed endpoint falls back rather than
 * throwing, so a typo in a settings field degrades to the default instead of
 * breaking every upload.
 */
function originFor(p: R2PresignParams): { origin: string; host: string } {
  const raw = (p.endpoint ?? '').trim();
  if (raw !== '') {
    try {
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
      return { origin: `${url.protocol}//${url.host}`, host: url.host };
    } catch {
      // fall through to the default
    }
  }
  const host = `${p.accountId}.r2.cloudflarestorage.com`;
  return { origin: `https://${host}`, host };
}

/**
 * Build a presigned R2 URL for a single object key. The URL is valid for
 * expiresInSeconds and carries the full SigV4 query string; the caller has
 * already confirmed the key belongs to the acting tenant.
 */
export async function presignR2Url(p: R2PresignParams): Promise<string> {
  const { origin, host } = originFor(p);
  const canonicalUri = `/${awsUriEncode(p.bucket, false)}/${awsUriEncode(p.key, false)}`;

  const amzDate = p.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  const query: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${p.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(p.expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${awsUriEncode(k, true)}=${awsUriEncode(query[k], true)}`)
    .join('&');

  const canonicalRequest = [
    p.method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    await sha256HexOfString(canonicalRequest),
  ].join('\n');

  const key = await signingKey(p.secretAccessKey, dateStamp);
  const signature = toHex(await hmac(key, stringToSign));

  return `${origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
