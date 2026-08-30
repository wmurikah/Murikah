/**
 * The one diff renderer.
 *
 * Section 4 of the phase says a second diff implementation is the defect the
 * sentence prevents, so this module is the only place a before-and-after
 * comparison is computed anywhere in the application. Everything that shows
 * a change calls `diffPayloads`.
 *
 * WHAT IT PRODUCES IS BUSINESS LANGUAGE, NOT JSON. `role_permissions` becomes
 * "Role permissions", `effective_to` becomes "Effective to", an absent value
 * reads "Not set" rather than "null", and a boolean reads "Yes" or "No"
 * rather than 1 and 0. Raw JSON is available behind a disclosure for somebody
 * who needs it, but it is not the reading experience.
 *
 * NULL IS NOT ZERO AND NOT EMPTY, and that distinction survives here: "Not
 * set" is used for null and undefined only, an empty string renders as
 * "Empty", and a zero renders as 0. A reader deciding whether somebody
 * removed a value or entered nothing needs the three to look different.
 */
import { isSensitiveKey, MASKED_PLACEHOLDER } from './mask.ts';

export type DiffKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface DiffRow {
  /** The dotted path, kept for grouping and for the technical view. */
  readonly path: string;
  /** The path in business language, which is what the table shows. */
  readonly label: string;
  readonly kind: DiffKind;
  /** Already rendered for display, and already masked. */
  readonly before: string;
  readonly after: string;
  /** True where the value was withheld rather than absent. */
  readonly masked: boolean;
}

/** Long text is folded rather than truncated, so nothing is lost silently. */
export const LONG_TEXT_THRESHOLD = 120;

/**
 * `sla_target_minutes` becomes `SLA target minutes`, `effectiveTo` becomes
 * `Effective to`, `role_permissions.0.permission_id` becomes
 * `Role permissions, item 1, permission id`.
 *
 * The array index is rendered one-based because the reader is a person
 * counting items in a list, not a programmer indexing an array.
 */
export function humanLabel(path: string): string {
  const parts = path.split('.').map((segment) => {
    if (/^\d+$/.test(segment)) return `item ${Number(segment) + 1}`;
    const spaced = segment
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .trim()
      .toLowerCase();
    // A handful of initialisms that read wrong in lower case.
    return spaced
      .replace(/\bsla\b/g, 'SLA')
      .replace(/\bid\b/g, 'id')
      .replace(/\bmfa\b/g, 'MFA')
      .replace(/\bip\b/g, 'IP');
  });
  const joined = parts.join(', ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/** How one leaf value is shown. Never "null", never "[object Object]". */
export function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'Not set';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value === '' ? 'Empty' : value;
  if (Array.isArray(value)) return value.length === 0 ? 'Empty list' : `${value.length} items`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length === 0 ? 'Empty' : `${keys.length} fields`;
  }
  return String(value);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function walk(
  before: unknown,
  after: unknown,
  path: string,
  rows: DiffRow[],
  includeUnchanged: boolean,
): void {
  // A sensitive key stops the walk. Neither side is rendered and neither side
  // is descended into, so a token nested inside a masked object cannot escape
  // through a child path.
  if (path !== '' && isSensitiveKey(path)) {
    const present = (v: unknown) => v !== null && v !== undefined;
    const kind: DiffKind = !present(before)
      ? present(after)
        ? 'added'
        : 'unchanged'
      : !present(after)
        ? 'removed'
        : JSON.stringify(before) === JSON.stringify(after)
          ? 'unchanged'
          : 'changed';
    if (kind !== 'unchanged' || includeUnchanged) {
      rows.push({
        path,
        label: humanLabel(path),
        kind,
        before: present(before) ? MASKED_PLACEHOLDER : 'Not set',
        after: present(after) ? MASKED_PLACEHOLDER : 'Not set',
        masked: true,
      });
    }
    return;
  }

  // A creation has no before and a deletion has no after. Descending with the
  // absent side treated as empty reports the individual fields as added or
  // removed, which is what a reader needs. Comparing null against the whole
  // object instead collapses a creation into one row reading "value: added",
  // which says nothing about what was created.
  const absent = (v: unknown) => v === null || v === undefined;
  if (absent(before) && (isPlainObject(after) || Array.isArray(after))) {
    walk(Array.isArray(after) ? [] : {}, after, path, rows, includeUnchanged);
    return;
  }
  if (absent(after) && (isPlainObject(before) || Array.isArray(before))) {
    walk(before, Array.isArray(before) ? [] : {}, path, rows, includeUnchanged);
    return;
  }

  // Both sides objects: recurse over the union of their keys, so a field that
  // exists on one side only is reported as added or removed rather than lost.
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      walk(before[key], after[key], path === '' ? key : `${path}.${key}`, rows, includeUnchanged);
    }
    return;
  }

  // Arrays compare element by element up to the longer length, which reports
  // an appended item as added and a removed one as removed rather than
  // reporting the whole list as changed and leaving the reader to spot it.
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      walk(before[index], after[index], `${path}.${index}`, rows, includeUnchanged);
    }
    return;
  }

  const same = JSON.stringify(before ?? null) === JSON.stringify(after ?? null);
  const beforeAbsent = before === null || before === undefined;
  const afterAbsent = after === null || after === undefined;
  const kind: DiffKind = same
    ? 'unchanged'
    : beforeAbsent
      ? 'added'
      : afterAbsent
        ? 'removed'
        : 'changed';
  if (kind === 'unchanged' && !includeUnchanged) return;

  rows.push({
    path: path === '' ? 'value' : path,
    label: humanLabel(path === '' ? 'value' : path),
    kind,
    before: renderValue(before),
    after: renderValue(after),
    masked: false,
  });
}

export interface DiffResult {
  readonly rows: DiffRow[];
  /** True where both sides were absent, so there is nothing to show. */
  readonly empty: boolean;
  /**
   * Set where a stored payload could not be parsed. The interface says so
   * rather than rendering an empty diff, because an empty diff and an
   * unreadable one are different facts.
   */
  readonly parseError: string | null;
}

function parse(raw: string | null): { value: unknown; error: string | null } {
  if (raw === null || raw.trim() === '') return { value: null, error: null };
  try {
    return { value: JSON.parse(raw), error: null };
  } catch {
    return { value: null, error: 'The stored payload is not valid JSON and cannot be compared.' };
  }
}

/**
 * The field-level diff between two stored JSON payloads.
 *
 * Either side may be null: a creation has no before, a deletion has no after,
 * and both read correctly as a list of added or removed fields rather than as
 * an error.
 */
export function diffPayloads(
  beforeJson: string | null,
  afterJson: string | null,
  options: { includeUnchanged?: boolean } = {},
): DiffResult {
  const before = parse(beforeJson);
  const after = parse(afterJson);
  const parseError = before.error ?? after.error;
  if (parseError !== null) return { rows: [], empty: true, parseError };

  if (before.value === null && after.value === null) {
    return { rows: [], empty: true, parseError: null };
  }

  const rows: DiffRow[] = [];
  walk(before.value, after.value, '', rows, options.includeUnchanged === true);
  return { rows, empty: rows.length === 0, parseError: null };
}

/** A one-line summary for a list row, where a table has no space for a diff. */
export function summariseDiff(result: DiffResult): string {
  if (result.parseError !== null) return 'Payload unreadable';
  const changed = result.rows.filter((row) => row.kind !== 'unchanged');
  if (changed.length === 0) return 'No field-level detail recorded';
  const names = changed.slice(0, 3).map((row) => row.label);
  const rest = changed.length - names.length;
  return rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ');
}
