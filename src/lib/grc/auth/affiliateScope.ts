/**
 * Affiliate confinement: the second dimension of access, beside the module and
 * action grants (Build Prompt 45).
 *
 * A role can be marked confined to its user's affiliate. A user holding that
 * role then sees only records whose `affiliate_code` matches their own
 * `users.affiliate_code`, on top of the grants they already hold. Confinement
 * never widens access: it only ever removes rows a grant would otherwise have
 * shown. An unconfined role behaves exactly as before, seeing the whole
 * organisation within its grants.
 *
 * This is deliberately narrow. The audit's recommendation was a legible scope
 * using columns that already exist (`affiliate_code` on `users`, `work_papers`
 * and `action_plans`), not a general attribute-based policy engine: on an
 * assurance platform, "why could this person see this?" has to be answerable by
 * reading rows on a screen, not by tracing a policy evaluation.
 *
 * The three states are distinct on purpose, and the third is the one that
 * matters. A confined role whose user has no affiliate assigned yields no rows
 * at all, and that is a configuration mistake rather than an empty list: the
 * screens say so rather than showing a clean "nothing here yet", which would
 * read as "your organisation has no findings".
 *
 * No imports, so node strips the types and the unit tests run this directly.
 */

/** The affiliate confinement in force for the viewer, as the middleware resolves it. */
export interface AffiliateScope {
  /** True when the viewer's role is marked confined to its user's affiliate. */
  confined: boolean;
  /** The viewer's own `users.affiliate_code`, or null when they have none. */
  affiliateCode: string | null;
}

/** The scope for a viewer no confinement applies to. */
export const UNCONFINED: AffiliateScope = { confined: false, affiliateCode: null };

/**
 * Resolve the confinement for a request.
 *
 * A platform owner is never confined: they act above the customers and hold the
 * full matrix, so there is no role row carrying the flag for them. The same
 * holds for a SUPER_ADMIN, whose matrix is synthesised rather than read.
 */
export function resolveAffiliateScope(
  confinedRole: boolean,
  affiliateCode: string | null,
  isPlatformOwner: boolean,
): AffiliateScope {
  if (isPlatformOwner || !confinedRole) return UNCONFINED;
  return { confined: true, affiliateCode: affiliateCode === '' ? null : affiliateCode };
}

/** True when the role is confined but the user has no affiliate to confine to. */
export function isConfinedWithoutAffiliate(scope: AffiliateScope): boolean {
  return scope.confined && scope.affiliateCode === null;
}

/** A SQL fragment and its arguments, to append to a WHERE clause. */
export interface ScopePredicate {
  /** Begins with ' AND ', or is empty when nothing should be appended. */
  clause: string;
  args: string[];
}

const NO_PREDICATE: ScopePredicate = { clause: '', args: [] };

/**
 * The predicate that confines a query to the viewer's affiliate.
 *
 * `column` is the qualified column to compare, taken from the typed layer by the
 * caller (for example `wp.affiliate_code`), so a wrong name is still a compile
 * error at the call site.
 *
 * The confined-with-no-affiliate case returns `AND 1 = 0` rather than an empty
 * predicate. That is the whole difference between a boundary and a filter: a
 * missing affiliate must close the door, never leave it open. Returning nothing
 * here would silently show a user in a confined role the entire organisation,
 * which is the exact failure this feature exists to prevent.
 */
export function affiliatePredicate(scope: AffiliateScope, column: string): ScopePredicate {
  if (!scope.confined) return NO_PREDICATE;
  if (scope.affiliateCode === null) return { clause: ' AND 1 = 0', args: [] };
  return { clause: ` AND ${column} = ?`, args: [scope.affiliateCode] };
}

/**
 * Whether a single row's affiliate is visible under the scope. For the detail
 * reads and the row-level checks, where a predicate cannot be appended.
 */
export function affiliateVisible(scope: AffiliateScope, rowAffiliate: string | null): boolean {
  if (!scope.confined) return true;
  if (scope.affiliateCode === null) return false;
  return rowAffiliate === scope.affiliateCode;
}

/** A stable key for the scope, so two viewers never share a cached aggregation. */
export function affiliateScopeKey(scope: AffiliateScope): string {
  if (!scope.confined) return 'all';
  return `aff=${scope.affiliateCode ?? 'none'}`;
}
