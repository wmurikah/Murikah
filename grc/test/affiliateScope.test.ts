/**
 * Affiliate confinement (Build Prompt 45): the pure core.
 *
 * The module under test has no imports, so node strips types and runs it
 * directly. These pin the three states and, above all, the one that is easy to
 * get wrong: a confined role whose user has no affiliate must close the door,
 * not leave it open.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AffiliateScope } from '../../src/lib/grc/auth/affiliateScope.ts';
import {
  UNCONFINED,
  resolveAffiliateScope,
  isConfinedWithoutAffiliate,
  affiliatePredicate,
  affiliateVisible,
  affiliateScopeKey,
} from '../../src/lib/grc/auth/affiliateScope.ts';

/** A confined scope, the shape the middleware would produce for a non-group user. */
const confinedTo = (affiliateCode: string | null): AffiliateScope => ({
  confined: true,
  affiliateCode,
  groupExempt: false,
});

test('resolveAffiliateScope confines only a confined role with a real user', () => {
  const confined = resolveAffiliateScope(true, 'HKL', false);
  assert.deepEqual(confined, confinedTo('HKL'));

  // An unconfined role is untouched, whatever affiliate the user carries.
  assert.deepEqual(resolveAffiliateScope(false, 'HKL', false), UNCONFINED);

  // A platform owner acts above the customers and holds a synthesised matrix, so
  // no role row carries the flag for them.
  assert.deepEqual(resolveAffiliateScope(true, 'HKL', true), UNCONFINED);

  // An empty affiliate is the same as none: a blank column must not become a
  // predicate that matches blank rows.
  assert.deepEqual(resolveAffiliateScope(true, '', false), confinedTo(null));
  assert.deepEqual(resolveAffiliateScope(true, null, false), confinedTo(null));
});

test('a group affiliate is exempt from confinement (Build Prompt 48)', () => {
  // The exemption is a property of the business unit, so it arrives as the
  // is_group flag for the viewer's own affiliate, resolved once per request.
  const group = resolveAffiliateScope(true, 'GROUP', false, true);
  assert.equal(group.confined, false, 'a group user is not narrowed');
  assert.equal(group.groupExempt, true, 'and the screens can say why');
  assert.equal(group.affiliateCode, 'GROUP', 'their affiliate is still known');

  // The predicate follows from `confined` alone, which is what keeps every
  // repository a two-case decision that cannot forget the exemption.
  assert.deepEqual(affiliatePredicate(group, 'wp.affiliate_code'), { clause: '', args: [] });
  assert.equal(affiliateVisible(group, 'ANY-OTHER-AFFILIATE'), true);
  assert.equal(affiliateVisible(group, null), true);

  // A non-group affiliate under the same role is unchanged.
  assert.deepEqual(resolveAffiliateScope(true, 'HKL', false, false), confinedTo('HKL'));

  // The exemption needs an affiliate to hang off. A confined user with none is
  // not exempt: there is no unit that could have been marked a group, so they
  // still see nothing until one is assigned.
  const none = resolveAffiliateScope(true, null, false, true);
  assert.equal(none.confined, true);
  assert.equal(none.groupExempt, false);
  assert.equal(isConfinedWithoutAffiliate(none), true);
  assert.equal(affiliatePredicate(none, 'wp.affiliate_code').clause, ' AND 1 = 0');

  // The flag cannot widen an unconfined role or reach a platform owner: both
  // are already unconfined, and neither gains a spurious exemption notice.
  assert.deepEqual(resolveAffiliateScope(false, 'GROUP', false, true), UNCONFINED);
  assert.deepEqual(resolveAffiliateScope(true, 'GROUP', true, true), UNCONFINED);

  // A group-exempt viewer sees exactly what an unconfined one sees, so they
  // share a cache key rather than needlessly halving the hit rate.
  assert.equal(affiliateScopeKey(group), affiliateScopeKey(UNCONFINED));
});

test('a confined user with no affiliate is a configuration state, not an empty list', () => {
  assert.equal(isConfinedWithoutAffiliate(resolveAffiliateScope(true, null, false)), true);
  assert.equal(isConfinedWithoutAffiliate(resolveAffiliateScope(true, 'HKL', false)), false);
  assert.equal(isConfinedWithoutAffiliate(UNCONFINED), false);
});

test('affiliatePredicate closes the door when there is no affiliate to open it with', () => {
  // Unconfined: nothing is appended, so every existing query is unchanged.
  assert.deepEqual(affiliatePredicate(UNCONFINED, 'wp.affiliate_code'), { clause: '', args: [] });

  // Confined with an affiliate: an ordinary equality, bound not interpolated.
  assert.deepEqual(affiliatePredicate(confinedTo('HKL'), 'wp.affiliate_code'), {
    clause: ' AND wp.affiliate_code = ?',
    args: ['HKL'],
  });

  // Confined with none: the whole point. An empty predicate here would show a
  // user in a confined role the entire organisation, which is the exact failure
  // the feature exists to prevent, so it must match nothing instead.
  const closed = affiliatePredicate(confinedTo(null), 'wp.affiliate_code');
  assert.equal(closed.clause, ' AND 1 = 0');
  assert.deepEqual(closed.args, []);
  assert.ok(closed.clause.startsWith(' AND '), 'a predicate must be appendable to a WHERE clause');
});

test('affiliateVisible is the same rule for a single row', () => {
  assert.equal(affiliateVisible(UNCONFINED, 'HKL'), true);
  assert.equal(affiliateVisible(UNCONFINED, null), true);
  assert.equal(affiliateVisible(confinedTo('HKL'), 'HKL'), true);
  assert.equal(affiliateVisible(confinedTo('HKL'), 'OTHER'), false);
  // A record with no affiliate is not visible to a confined viewer: it belongs
  // to no affiliate, so it belongs to none of theirs.
  assert.equal(affiliateVisible(confinedTo('HKL'), null), false);
  assert.equal(affiliateVisible(confinedTo(null), 'HKL'), false);
  assert.equal(affiliateVisible(confinedTo(null), null), false);
});

test('the scope key separates cached aggregations that are genuinely different', () => {
  const all = affiliateScopeKey(UNCONFINED);
  const hkl = affiliateScopeKey(confinedTo('HKL'));
  const other = affiliateScopeKey(confinedTo('OTHER'));
  const none = affiliateScopeKey(confinedTo(null));
  // Four distinct viewers, four distinct keys: a shared entry would hand one
  // viewer another's totals.
  assert.equal(new Set([all, hkl, other, none]).size, 4);
});
