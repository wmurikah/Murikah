/**
 * Every cache key the GRC platform uses, named in one place.
 *
 * Centralising the names is what makes invalidation provable: a write path
 * cannot silently serve stale data if the only way to name an entry is through
 * this catalogue, and cache/invalidate.ts derives what a mutation clears from
 * the very same builders the reads use.
 *
 * Tenancy. Every tenant-scoped key begins with the acting `organization_id`, so
 * one organisation's entry is unreachable from another's namespace and an
 * organisation can be flushed by prefix alone. Each segment is percent-encoded,
 * so an identifier that happens to contain a colon cannot forge its way into a
 * neighbouring namespace. The namespace is a convenience for flushing and never
 * an authority: the acting organisation is still resolved and verified from the
 * session on the server, on every request, exactly as before.
 *
 * An empty organisation id (a platform owner who has entered no instance) yields
 * the empty key, which cache/core.ts treats as "not cacheable" and passes
 * straight through to the database. No instance means no cached entry.
 *
 * Platform reference data that genuinely belongs to no tenant (the enum labels)
 * sits under the reserved GLOBAL namespace, matching the `GLOBAL` sentinel the
 * config table already uses. Nothing tenant derived is ever placed there.
 *
 * The role permission matrix is deliberately absent, and there is no key for it
 * to be reached by. An authorisation decision is read fresh from the database on
 * every request (`src/lib/grc/auth/rbac.ts`), so an access change applies on the
 * very next request everywhere rather than once an invalidation has propagated
 * (Build Prompt 43).
 *
 * No imports, so node strips the types and the unit tests run this directly.
 */

/** Bumping this retires every entry at once, for a format change. */
export const CACHE_VERSION = 'v1';

const ROOT = `grc:${CACHE_VERSION}`;

/** The reserved namespace for platform reference data that belongs to no tenant. */
export const PLATFORM_NAMESPACE = 'GLOBAL';

/**
 * Lifetimes, in seconds.
 *
 * `reference` covers the slowly changing, explicitly invalidated entries: the
 * audit universe, affiliates, the dropdown vocabularies, the general settings
 * and the subscription. `dashboard` is the short window the expensive
 * aggregations may lag by. There is no authorisation lifetime here on purpose:
 * nothing the access decision rests on is cached at all.
 */
export const CACHE_TTL = {
  reference: 300,
  dashboard: 60,
} as const;

function segment(raw: string): string {
  return encodeURIComponent(raw);
}

/**
 * The prefix every entry for an organisation shares. Empty when there is no
 * acting organisation, which makes the derived keys empty too.
 */
export function namespaceFor(organizationId: string): string {
  if (organizationId === '') return '';
  return `${ROOT}:${segment(organizationId)}:`;
}

function key(organizationId: string, ...parts: string[]): string {
  const ns = namespaceFor(organizationId);
  if (ns === '') return '';
  return ns + parts.map(segment).join(':');
}

function prefix(organizationId: string, ...parts: string[]): string {
  const ns = namespaceFor(organizationId);
  if (ns === '') return '';
  return `${ns}${parts.map(segment).join(':')}:`;
}

/**
 * The `config` keys that may be cached. An allow-list, not a deny-list, because
 * the live `config` table is also where the per-user MFA records live
 * (`MFA_TOTP::<user_id>`), and authentication state must never be cached beyond
 * the life of one request. A key absent from here reads straight from the
 * database, so a new config key is uncached until someone deliberately adds it.
 */
export function isCacheableConfigKey(configKey: string, allowed: readonly string[]): boolean {
  return allowed.includes(configKey);
}

export const cacheKeys = {
  /** The audit universe: an organisation's audit areas, with their sub-area counts. */
  auditAreas: (org: string): string => key(org, 'audit-universe', 'areas'),
  /** Sub-areas under one audit area (the setup screen reads them per area). */
  subAreas: (org: string, auditAreaId: string): string =>
    key(org, 'audit-universe', 'sub-areas', auditAreaId),
  /** Everything derived from the audit universe, for a single prefix delete. */
  auditUniversePrefix: (org: string): string => prefix(org, 'audit-universe'),

  /** The affiliate list for the setup and user screens. */
  affiliates: (org: string): string => key(org, 'affiliates', 'all'),
  affiliatesPrefix: (org: string): string => prefix(org, 'affiliates'),

  /** The work-paper form and filter lookups, a narrower active-only projection. */
  lookupAuditAreas: (org: string): string => key(org, 'lookups', 'audit-areas'),
  lookupAffiliates: (org: string): string => key(org, 'lookups', 'affiliates'),
  lookupSubAreas: (org: string, auditAreaId: string | undefined): string =>
    key(org, 'lookups', 'sub-areas', auditAreaId ?? 'all'),
  lookupsPrefix: (org: string): string => prefix(org, 'lookups'),

  /** One managed DROPDOWN_* vocabulary. */
  dropdown: (org: string, vocabulary: string): string => key(org, 'dropdown', vocabulary),
  dropdownPrefix: (org: string): string => prefix(org, 'dropdown'),

  /** One general setting from the config table (allow-listed keys only). */
  config: (org: string, configKey: string): string => key(org, 'config', configKey),
  configPrefix: (org: string): string => prefix(org, 'config'),

  /** The organisation's subscription and its resolved plan feature flags. */
  subscription: (org: string): string => key(org, 'subscription'),

  /**
   * A dashboard aggregation. `view` names the panel and `scope` carries every
   * other input that changes the answer (the year, or the user whose own items
   * are counted), so two users never share an entry that was scoped to one.
   */
  dashboard: (org: string, view: string, scope: string): string =>
    key(org, 'dashboard', view, scope),
  dashboardPrefix: (org: string): string => prefix(org, 'dashboard'),

  /** Display labels for an enum type. Platform reference data, no tenant content. */
  enumLabels: (enumType: string): string => key(PLATFORM_NAMESPACE, 'enum-labels', enumType),
  enumLabelsPrefix: (): string => prefix(PLATFORM_NAMESPACE, 'enum-labels'),
} as const;
