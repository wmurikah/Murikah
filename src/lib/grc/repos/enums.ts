/**
 * Read the display labels for an enum type from `enum_values`, so a status shows
 * as "Under Review" rather than a raw value. Reference data, shared across
 * organisations, so not org-scoped. Column names come from the typed schema
 * layer (`@grc/schema/columns`): the live table names the value `enum_value` and
 * the label `display_label`, ordered by `display_order`. Labels are cosmetic, so
 * any read failure is logged and falls back to humanising the value rather than
 * failing the page.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';

const TAG = '[grc.enums]';

function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export async function loadEnumLabels(db: Client, enumType: string): Promise<Map<string, string>> {
  const ev = cols(C.enum_values);
  try {
    const res = await db.execute({
      sql: `SELECT ${ev.enum_value} AS value, ${ev.display_label} AS label
              FROM enum_values
             WHERE ${ev.enum_type} = ? AND (${ev.is_active} IS NULL OR ${ev.is_active} = 1)
          ORDER BY ${ev.display_order}, ${ev.enum_value}`,
      args: [enumType],
    });
    return new Map(
      res.rows.map((r) => [
        String(r.value),
        r.label == null ? humanise(String(r.value)) : String(r.label),
      ]),
    );
  } catch (err) {
    console.error(`${TAG} loadEnumLabels(${enumType}) failed`, err);
    return new Map();
  }
}

/** The label for a value from a labels map, falling back to a humanised value. */
export function statusLabel(labels: Map<string, string>, value: string): string {
  return labels.get(value) ?? value.replace(/_/g, ' ');
}
