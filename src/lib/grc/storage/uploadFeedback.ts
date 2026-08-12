/**
 * What the evidence panel says while a file is uploading, and what it says when
 * the upload never arrives (Build Prompt 66).
 *
 * Evidence upload used to stick on "Uploading <file>..." for ever. The browser
 * PUTs the bytes straight to the organisation's bucket, and a bucket with no
 * CORS rule for this origin refuses the preflight, which surfaces in the browser
 * as a rejected promise rather than a failed response. Nothing caught it, so the
 * spinner never came down, the completion step never ran, and no `files` or
 * `file_attachments` row was ever written. An upload that cannot say it failed
 * is worse than one that fails: the auditor waits, and then sends the finding
 * believing the evidence is attached.
 *
 * The words live here, away from the panel, for two reasons. They are the same
 * words whether the failure came from the presigned PUT or from the worker, so
 * there is one sentence per kind of failure rather than one per call site. And
 * this module imports nothing, so the node tests exercise the real strings and
 * the real arithmetic instead of a copy that can drift from them.
 */

/**
 * How long a transfer may make no progress at all before it is given up on.
 *
 * This is deliberately a stall timeout, not a total one: a hundred-megabyte
 * scan over a depot's connection is legitimately slow, and a total timeout
 * would kill it halfway. What is never legitimate is silence. A blocked or
 * black-holed request produces no progress event at all, so it trips this in
 * twenty seconds, while a slow upload resets it with every chunk it manages.
 */
export const UPLOAD_STALL_MS = 20_000;

/** The tag an upload failure is logged under, so the console can be searched. */
export const UPLOAD_TAG = '[grc.evidence.upload]';

/**
 * Why an upload did not arrive.
 *
 * - `blocked`   the request to another origin got no response at all, which is
 *               what a bucket with no CORS rule for this site does.
 * - `unreachable` the same, on this site's own origin: the network failed.
 * - `stalled`   the transfer made no progress for UPLOAD_STALL_MS.
 * - `refused`   a real HTTP status came back, and it was not a success.
 * - `aborted`   the person cancelled it.
 */
export type UploadFailure = 'blocked' | 'unreachable' | 'stalled' | 'refused' | 'aborted';

export interface UploadFailureDetail {
  kind: UploadFailure;
  /** The HTTP status, or 0 when no response was received at all. */
  status: number;
  fileName: string;
  /** The origin the browser uploaded from, e.g. https://grc.murikah.com. */
  origin: string;
}

/**
 * A file size a person can read, in the decimal units browsers and operating
 * systems show, so 2,400,000 bytes reads as the 2.4 MB the file manager said.
 */
export function formatBytes(bytes: number): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = n / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // One decimal below a hundred, none above: "2.4 MB", "240 MB".
  const shown = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${units[unit]}`;
}

/**
 * Percent complete from the bytes actually acknowledged by the transfer. Zero
 * when the total is not known, because a bar that moves on a guess is a bar
 * that lies; the caller shows an indeterminate state instead.
 */
export function uploadPercent(loaded: number, total: number): number {
  const l = Number(loaded);
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(l)) return 0;
  return Math.max(0, Math.min(100, Math.floor((Math.max(0, l) / t) * 100)));
}

/** True when the URL is on an origin other than the page's own. */
export function isCrossOrigin(url: string, pageOrigin: string): boolean {
  const target = String(url ?? '').trim();
  if (target === '' || target.startsWith('/')) return false;
  try {
    return new URL(target, pageOrigin || 'https://example.invalid').origin !== pageOrigin;
  } catch {
    return false;
  }
}

/**
 * Name the failure from what the transfer reported.
 *
 * A status of 0 is the browser saying "there was no response": the request was
 * refused before it could be made, or the connection died. On a cross-origin
 * PUT that is overwhelmingly a CORS rejection, which is a configuration fault
 * with a specific cure, so it is worth telling apart from a flat network
 * failure rather than lumping both under "something went wrong".
 */
export function classifyUploadFailure(input: {
  status: number;
  timedOut?: boolean;
  aborted?: boolean;
  crossOrigin?: boolean;
}): UploadFailure {
  if (input.aborted) return 'aborted';
  if (input.timedOut) return 'stalled';
  const status = Number(input.status ?? 0);
  if (status > 0) return 'refused';
  return input.crossOrigin ? 'blocked' : 'unreachable';
}

/**
 * The sentence the person sees. Each one says what happened, and the one with a
 * cure says the cure: an administrator reading "the bucket needs a CORS rule
 * allowing PUT and GET from this address" can fix it, where "upload failed"
 * leaves them re-picking the same file for ever.
 */
export function uploadFailureMessage(d: UploadFailureDetail): string {
  const name = d.fileName || 'The file';
  const origin = d.origin || 'this site';
  switch (d.kind) {
    case 'blocked':
      return (
        `${name} could not be sent to the evidence store: the store refused the ` +
        `browser before the upload began. This is what a storage bucket with no ` +
        `cross-origin rule for ${origin} does. An administrator must allow PUT and ` +
        `GET from ${origin} on the evidence bucket, then try again.`
      );
    case 'unreachable':
      return `${name} could not be sent: the connection failed before it arrived. Try again.`;
    case 'stalled':
      return (
        `${name} stopped part way and was given up on after ` +
        `${Math.round(UPLOAD_STALL_MS / 1000)} seconds without progress. ` +
        `Check the connection and try again.`
      );
    case 'aborted':
      return `${name} was cancelled, so nothing was attached.`;
    default:
      return `${name} was refused by the evidence store (HTTP ${d.status}). Try again.`;
  }
}

/**
 * The console line an operator searches for. It carries the status, because
 * "the upload failed" tells nobody whether the bucket said 403, the signature
 * had expired or the request never left the browser.
 */
export function uploadLogLine(d: UploadFailureDetail & { url?: string }): string {
  return `${UPLOAD_TAG} ${d.kind} ${JSON.stringify({
    file_name: d.fileName,
    status: d.status,
    origin: d.origin,
    url: d.url ?? '',
  })}`;
}
