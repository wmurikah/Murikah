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
 * The Group exemption (Build Prompt 48) is the fourth state. An affiliate marked
 * `affiliates.is_group` is the organisation's Group or HQ unit, and a user posted
 * to it is exempt: a confined role has no narrowing effect on them and they see
 * every affiliate, exactly as an unconfined user would. That is a property of the
 * business unit rather than of the role or the person, which is why it is a row
 * on `affiliates` and not a code hard-wired into this file: a hard-coded 'GROUP'
 * would be right for one customer and wrong for the next, and invisible to a
 * reviewer either way. The exemption is carried as its own field rather than by
 * quietly returning UNCONFINED, so the screens can say why somebody sees
 * everything instead of leaving it to be inferred.
 *
 * No imports, so node strips the types and the unit tests run this directly.
 */

/** The affiliate confinement in force for the viewer, as the middleware resolves it. */
export interface AffiliateScope {
  /**
   * True when rows must actually be narrowed to `affiliateCode`. A confined role
   * whose user sits on a group affiliate is NOT confined: the exemption is
   * resolved before this is set, so every consumer of the predicate stays a
   * two-case decision and cannot forget the exemption.
   */
  confined: boolean;
  /** The viewer's own `users.affiliate_code`, or null when they have none. */
  affiliateCode: string | null;
  /**
   * True when the role is confined but the viewer's affiliate is a group, so the
   * confinement does not apply to them. Nothing in the data layer reads this; it
   * exists so the screens can explain why this viewer sees every affiliate.
   */
  groupExempt: boolean;
}

/** The scope for a viewer no confinement applies to. */
export const UNCONFINED: AffiliateScope = {
  confined: false,
  affiliateCode: null,
  groupExempt: false,
};

/**
 * Resolve the confinement for a request, once, from the viewer's identity.
 *
 * A platform owner is never confined: they act above the customers and hold the
 * full matrix, so there is no role row carrying the flag for them. The same
 * holds for a SUPER_ADMIN, whose matrix is synthesised rather than read.
 *
 * `isGroupAffiliate` is `affiliates.is_group` for the viewer's own affiliate,
 * resolved once per request by the middleware and never per row. When it is set,
 * a confined role stops narrowing: the viewer sees every affiliate within the
 * grants they already hold.
 *
 * The exemption deliberately requires an affiliate. A confined user with none is
 * not exempt, because there is no unit to have been marked a group; they still
 * see nothing until an administrator assigns them one, which is the state the
 * screens name.
 */
export function resolveAffiliateScope(
  confinedRole: boolean,
  affiliateCode: string | null,
  isPlatformOwner: boolean,
  isGroupAffiliate = false,
): AffiliateScope {
  if (isPlatformOwner || !confinedRole) return UNCONFINED;
  const code = affiliateCode === '' ? null : affiliateCode;
  if (code !== null && isGroupAffiliate) {
    return { confined: false, affiliateCode: code, groupExempt: true };
  }
  return { confined: true, affiliateCode: code, groupExempt: false };
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

/**
 * A stable key for the scope, so two viewers never share a cached aggregation.
 * A group-exempt viewer sees the same rows as an unconfined one, so they share
 * the same key: the figures are identical, and splitting them would only halve
 * the hit rate.
 */
export function affiliateScopeKey(scope: AffiliateScope): string {
  if (!scope.confined) return 'all';
  return `aff=${scope.affiliateCode ?? 'none'}`;
}
