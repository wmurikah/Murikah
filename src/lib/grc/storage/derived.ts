/**
 * Pure rules for the derived evidence artefacts (Build Prompt 32): the
 * distinct, deterministic display name every stored file gets, the check for
 * it, which mime types get which optimised copy, and the formatting-stripped
 * text preview. Import-free, so node strips types and unit-tests this
 * directly. The optimised copy's object key is derived in keys.ts; the Drive
 * mirror (storage/mirror.ts) uploads under the deterministic name, so the
 * name alone says what a file belongs to when browsing the folder.
 */

export type EvidenceKind = 'evidence' | 'update';

export interface EvidenceNameParts {
  /** The affiliate code, e.g. HKL. */
  affiliate: string;
  /** The parent work paper reference, e.g. WP/2026/002. */
  workPaperRef: string;
  /** evidence (a work paper) or update (an action plan management update). */
  kind: EvidenceKind;
  /** The file's created_at (ISO); the name carries its yyyymmdd. */
  dateIso: string;
  /** The 1-based position among the entity's attachments. */
  seq: number;
  /** The original's content hash; the name carries its first eight hex chars. */
  contentHash: string;
  /** The client filename, for the extension only. */
  originalName: string;
}

/** A name segment reduced to letters, digits and hyphens, never empty. */
function segment(value: string, fallback: string): string {
  const cleaned = String(value)
    .trim()
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? fallback : cleaned;
}

/** The extension of a client filename: short, alphanumeric, lower-case; 'bin' when odd. */
export function fileExtension(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(String(name).trim());
  return m ? m[1].toLowerCase() : 'bin';
}

/**
 * The deterministic display name:
 * {affiliate}_{work_paper_ref}_{kind}_{yyyymmdd}_{seq}_{shorthash}.{ext}.
 * The sequence and the content-hash prefix together make collisions
 * impossible in practice, and every part is readable by a human browsing the
 * Drive mirror.
 */
export function buildEvidenceName(parts: EvidenceNameParts): string {
  const date = /^\d{4}-\d{2}-\d{2}/.test(parts.dateIso)
    ? parts.dateIso.slice(0, 10).replace(/-/g, '')
    : '00000000';
  const seq = String(Math.max(1, Math.floor(parts.seq))).padStart(3, '0');
  const hash = /^[0-9a-f]{8}/.test(parts.contentHash) ? parts.contentHash.slice(0, 8) : 'nohash00';
  return (
    [
      segment(parts.affiliate, 'ORG'),
      segment(parts.workPaperRef, 'REF'),
      parts.kind,
      date,
      seq,
      hash,
    ].join('_') +
    '.' +
    fileExtension(parts.originalName)
  );
}

/** Whether a stored file_name already carries the deterministic pattern. */
export function isDeterministicName(name: string): boolean {
  return /^[A-Za-z0-9-]+_[A-Za-z0-9-]+_(evidence|update)_\d{8}_\d{3,}_[0-9a-z]{8}\.[a-z0-9]{1,10}$/.test(
    String(name),
  );
}

/** Images get a resized re-encoded copy (made client-side at upload). */
export function isOptimisableImage(mimeType: string): boolean {
  return /^image\/(jpeg|png|webp|gif|bmp|tiff?)$/i.test(String(mimeType));
}

/** Text-like documents get a formatting-stripped preview (made server-side). */
export function isOptimisableText(mimeType: string): boolean {
  return /^(text\/|application\/(json|xml|csv)$)/i.test(String(mimeType));
}

/** The mime type the optimised copy is stored and mirrored as. */
export function optimisedMime(originalMime: string): string {
  if (isOptimisableImage(originalMime)) return 'image/jpeg';
  if (isOptimisableText(originalMime)) return 'text/plain';
  return originalMime;
}

/** The longest edge the optimised image copy is resized to. */
export const OPTIMISED_IMAGE_MAX_EDGE = 1600;

/** The most bytes of a document read when building its text preview. */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

/**
 * The formatting-stripped preview of a text document: control characters
 * dropped (keeping newlines and tabs), trailing space removed, runs of blank
 * lines collapsed, and the whole capped, so previews stay small and fast.
 */
export function normalisePreviewText(text: string): string {
  const stripped = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return stripped.length > TEXT_PREVIEW_MAX_BYTES
    ? stripped.slice(0, TEXT_PREVIEW_MAX_BYTES)
    : stripped;
}
