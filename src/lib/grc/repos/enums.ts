/**
 * Read the display labels for an enum type from `enum_values`, so a status shows
 * as "Under review" rather than UNDER_REVIEW. Reference data, shared across
 * organisations, so not org-scoped. Tolerant of a schema without a label column:
 * it falls back to humanising the value.
 */
import type { Client } from '@libsql/client/web';

function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export async function loadEnumLabels(db: Client, enumType: string): Promise<Map<string, string>> {
  try {
    const res = await db.execute({
      sql: `SELECT value, label FROM enum_values WHERE enum_type = ? ORDER BY sort_order, value`,
      args: [enumType],
    });
    return new Map(
      res.rows.map((r) => [
        String(r.value),
        r.label == null ? humanise(String(r.value)) : String(r.label),
      ]),
    );
  } catch {
    const res = await db.execute({
      sql: `SELECT value FROM enum_values WHERE enum_type = ? ORDER BY value`,
      args: [enumType],
    });
    return new Map(res.rows.map((r) => [String(r.value), humanise(String(r.value))]));
  }
}

/** The label for a value from a labels map, falling back to a humanised value. */
export function statusLabel(labels: Map<string, string>, value: string): string {
  return labels.get(value) ?? value.replace(/_/g, ' ');
}
