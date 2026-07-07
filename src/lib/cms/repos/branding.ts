/**
 * Per-scope branding, ported from the source 40_svc_branding.gs. The live
 * `branding` table is keyed by scope_code: 'GLOBAL' or a country_code. A user's
 * country branding is used when present, otherwise the GLOBAL row, otherwise the
 * Murikah default, so the shell always has a name and a colour set. Column names
 * come from the typed layer.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@cms/schema/columns';

const B = cols(C.branding);

export interface Branding {
  appName: string;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
}

/** The Murikah house default, used when a scope has not branded. */
export const DEFAULT_BRANDING: Branding = {
  appName: 'Hass CMS',
  logoUrl: null,
  primaryColor: '#0b1733',
  secondaryColor: '#1f2d5c',
  accentColor: '#c9a227',
};

const s = (v: unknown): string | null => (v == null ? null : String(v));

/**
 * Resolve branding for a scope: the country row if it exists, else GLOBAL, else
 * the Murikah default. A missing colour falls back field by field, so a partial
 * brand row never yields an unstyled shell.
 */
export async function loadBranding(db: Client, countryCode: string | null): Promise<Branding> {
  const scopes = countryCode ? [countryCode, 'GLOBAL'] : ['GLOBAL'];
  const placeholders = scopes.map(() => '?').join(', ');
  const res = await db.execute({
    sql: `SELECT ${B.scope_code} AS scope_code, ${B.app_name} AS app_name, ${B.logo_url} AS logo_url,
                 ${B.primary_color} AS primary_color, ${B.secondary_color} AS secondary_color,
                 ${B.accent_color} AS accent_color
            FROM branding WHERE ${B.scope_code} IN (${placeholders})`,
    args: scopes,
  });
  // Prefer the most specific scope present (country before GLOBAL).
  const byScope = new Map(res.rows.map((r) => [String(r.scope_code), r]));
  const row = scopes.map((sc) => byScope.get(sc)).find(Boolean);
  if (!row) return DEFAULT_BRANDING;
  return {
    appName: s(row.app_name) ?? DEFAULT_BRANDING.appName,
    logoUrl: s(row.logo_url),
    primaryColor: s(row.primary_color) ?? DEFAULT_BRANDING.primaryColor,
    secondaryColor: s(row.secondary_color) ?? DEFAULT_BRANDING.secondaryColor,
    accentColor: s(row.accent_color) ?? DEFAULT_BRANDING.accentColor,
  };
}
