/**
 * Managed dropdown values for the work-paper control fields, ported from
 * 11_DropdownService.gs. The risk rating and the control classification, type and
 * frequency are held per organisation as JSON arrays in the `config` table
 * (keyed by organization_id), so a SUPER_ADMIN can manage them. control_standards
 * stays free text. The standard defaults live here, in one place, in step with
 * the seed scripts and the signup provisioning. Column names come from the typed
 * schema layer.
 *
 * Values are cache-aside per organisation and vocabulary (Build Prompt 42), and
 * saveDropdown invalidates the one it wrote before returning. This replaces the
 * module-level map that used to sit here: that map lived for the isolate's whole
 * life and could only ever be cleared in the isolate that happened to serve the
 * write, so an edit made at one edge stayed invisible at another indefinitely.
 * The shared cache is cleared for every edge, and the entry expires regardless.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import { CACHE_TTL, cacheKeys, cached } from '@grc/cache';
import { invalidateAllDropdowns, invalidateDropdown } from '@grc/cache/invalidate';
import {
  DROPDOWN_DEFAULTS,
  DROPDOWN_KEYS,
  type ControlDropdowns,
  type DropdownKey,
} from './dropdownDefaults';

// Re-export the pure constants so existing consumers keep importing them from
// here; the defaults themselves live in the leaf dropdownDefaults.ts.
export { DROPDOWN_DEFAULTS, DROPDOWN_KEYS };
export type { ControlDropdowns, DropdownKey };

const cfg = cols(C.config);

function parseArray(raw: string | null, fallback: string[]): string[] {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const values = parsed.map((v) => String(v).trim()).filter(Boolean);
      return values.length > 0 ? values : fallback;
    }
  } catch {
    // fall back to the default set
  }
  return fallback;
}

/** One dropdown's values for an organisation, from config, falling back to the default. */
export async function loadDropdown(
  db: Client,
  organizationId: string,
  key: DropdownKey,
  fallback: string[],
): Promise<string[]> {
  return cached(db, cacheKeys.dropdown(organizationId, key), CACHE_TTL.reference, async () => {
    try {
      const res = await db.execute({
        sql: `SELECT ${cfg.config_value} FROM config
             WHERE ${cfg.organization_id} = ? AND ${cfg.config_key} = ? LIMIT 1`,
        args: [organizationId, key],
      });
      const raw = res.rows[0]?.config_value;
      return parseArray(raw == null ? null : String(raw), fallback);
    } catch {
      // no config row: use the default
      return fallback;
    }
  });
}

/** All four control-field dropdowns for the work-paper form. */
export async function loadControlDropdowns(
  db: Client,
  organizationId: string,
): Promise<ControlDropdowns> {
  const [riskRatings, classification, controlType, controlFrequency] = await Promise.all([
    loadDropdown(db, organizationId, DROPDOWN_KEYS.riskRatings, DROPDOWN_DEFAULTS.riskRatings),
    loadDropdown(
      db,
      organizationId,
      DROPDOWN_KEYS.classification,
      DROPDOWN_DEFAULTS.classification,
    ),
    loadDropdown(db, organizationId, DROPDOWN_KEYS.controlType, DROPDOWN_DEFAULTS.controlType),
    loadDropdown(
      db,
      organizationId,
      DROPDOWN_KEYS.controlFrequency,
      DROPDOWN_DEFAULTS.controlFrequency,
    ),
  ]);
  return { riskRatings, classification, controlType, controlFrequency };
}

/** Replace one dropdown's values (SUPER_ADMIN), updating or inserting the config row. */
export async function saveDropdown(
  db: Client,
  organizationId: string,
  key: DropdownKey,
  values: string[],
): Promise<void> {
  const clean = values.map((v) => v.trim()).filter(Boolean);
  const json = JSON.stringify(clean);
  const now = new Date().toISOString();
  const upd = await db.execute({
    sql: `UPDATE config SET ${cfg.config_value} = ?, ${cfg.updated_at} = ?
           WHERE ${cfg.organization_id} = ? AND ${cfg.config_key} = ?`,
    args: [json, now, organizationId, key],
  });
  if ((upd.rowsAffected ?? 0) === 0) {
    await db.execute({
      sql: `INSERT INTO config (${cfg.organization_id}, ${cfg.config_key}, ${cfg.config_value}, ${cfg.updated_at})
             VALUES (?, ?, ?, ?)`,
      args: [organizationId, key, json, now],
    });
  }
  await invalidateDropdown(db, organizationId, key);
}

/** Invalidate every cached vocabulary for an organisation. */
export async function invalidateDropdownCache(db: Client, organizationId: string): Promise<void> {
  await invalidateAllDropdowns(db, organizationId);
}
