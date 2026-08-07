/**
 * What each mutation clears, in one place.
 *
 * Cache keys are named in cache/keys.ts and cleared here, and nowhere else. A
 * write path that reaches for a raw key string is the bug this file exists to
 * prevent: every repo mutation calls the function for its own domain, so adding
 * a new write path means calling an existing invalidator, not inventing one.
 *
 * The bias is deliberate: when a change could plausibly touch a derived entry,
 * clear it. Over-invalidating costs one database read; under-invalidating shows
 * a user data they could act on wrongly.
 *
 * Each function takes the request's memo owner (the libSQL client the mutation
 * ran on), so the entry is dropped from this request's memo as well as from the
 * shared cache. A read later in the same request then sees the new value.
 */
import { cacheKeys, invalidateKeys, invalidatePrefixes, namespaceFor } from './index.ts';
import type { MemoOwner } from './core.ts';

/**
 * The audit universe changed: areas, sub-areas, and everything projected from
 * them. The dashboard charts group by audit area, so they go too.
 */
export async function invalidateAuditUniverse(
  owner: MemoOwner | null,
  organizationId: string,
): Promise<void> {
  await invalidatePrefixes(owner, [
    cacheKeys.auditUniversePrefix(organizationId),
    cacheKeys.lookupsPrefix(organizationId),
    cacheKeys.dashboardPrefix(organizationId),
  ]);
}

/** An affiliate changed: the setup list and the form lookups. */
export async function invalidateAffiliates(
  owner: MemoOwner | null,
  organizationId: string,
): Promise<void> {
  await invalidatePrefixes(owner, [
    cacheKeys.affiliatesPrefix(organizationId),
    cacheKeys.lookupsPrefix(organizationId),
  ]);
}

/** One DROPDOWN_* vocabulary changed. */
export async function invalidateDropdown(
  owner: MemoOwner | null,
  organizationId: string,
  vocabulary: string,
): Promise<void> {
  await invalidateKeys(owner, [cacheKeys.dropdown(organizationId, vocabulary)]);
  // The vocabularies are stored as config rows, so clear that view of them too.
  await invalidatePrefixes(owner, [cacheKeys.configPrefix(organizationId)]);
}

/** Every vocabulary for an organisation. */
export async function invalidateAllDropdowns(
  owner: MemoOwner | null,
  organizationId: string,
): Promise<void> {
  await invalidatePrefixes(owner, [cacheKeys.dropdownPrefix(organizationId)]);
}

/**
 * One general setting changed. Config entries are keyed by the set of keys a
 * caller asked for, so the whole config namespace goes rather than one entry:
 * working out which combinations contained this key is exactly the reasoning a
 * new read path would silently invalidate. Settings are written rarely, and the
 * cost of clearing too much is one database read.
 */
export async function invalidateConfigKey(
  owner: MemoOwner | null,
  organizationId: string,
  configKey: string,
): Promise<void> {
  await invalidatePrefixes(owner, [cacheKeys.configPrefix(organizationId)]);
  await invalidateKeys(owner, [cacheKeys.dropdown(organizationId, configKey)]);
}

/** The subscription or its plan changed, so the feature flags must be re-read. */
export async function invalidateSubscription(
  owner: MemoOwner | null,
  organizationId: string,
): Promise<void> {
  await invalidateKeys(owner, [cacheKeys.subscription(organizationId)]);
}

/**
 * A work paper or action plan changed, so every dashboard aggregation for the
 * organisation is stale. Cheaper than reasoning about which panel moved, and it
 * cannot be wrong.
 */
export async function invalidateDashboard(
  owner: MemoOwner | null,
  organizationId: string,
): Promise<void> {
  await invalidatePrefixes(owner, [cacheKeys.dashboardPrefix(organizationId)]);
}

/**
 * A `role_permissions` write. This is the invalidation that makes an access
 * change take effect on the very next request rather than at the next sign-in,
 * so it runs immediately after the grant is stored, before the response is
 * returned. The matrix TTL (CACHE_TTL.roleMatrix) is the backstop for an edge
 * the delete has not yet reached.
 */
export async function invalidateRoleMatrix(roleCode?: string): Promise<void> {
  if (roleCode) {
    await invalidateKeys(null, [cacheKeys.roleMatrix(roleCode)]);
    return;
  }
  await invalidatePrefixes(null, [cacheKeys.roleMatrixPrefix()]);
}

/** An enum vocabulary changed (operator-managed reference data). */
export async function invalidateEnumLabels(enumType: string): Promise<void> {
  await invalidateKeys(null, [cacheKeys.enumLabels(enumType)]);
}

/**
 * Drop everything cached for one organisation. The recovery lever: a cache
 * problem confined to a tenant is fixed without a deploy and without touching
 * anybody else's entries. Returns how many entries were removed.
 */
export async function flushOrganisation(
  owner: MemoOwner | null,
  organizationId: string,
): Promise<number> {
  const namespace = namespaceFor(organizationId);
  if (namespace === '') return 0;
  return invalidatePrefixes(owner, [namespace]);
}
