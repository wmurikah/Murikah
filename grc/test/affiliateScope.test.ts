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
import {
  UNCONFINED,
  resolveAffiliateScope,
  isConfinedWithoutAffiliate,
  affiliatePredicate,
  affiliateVisible,
  affiliateScopeKey,
} from '../../src/lib/grc/auth/affiliateScope.ts';

test('resolveAffiliateScope confines only a confined role with a real user', () => {
  const confined = resolveAffiliateScope(true, 'HKL', false);
  assert.deepEqual(confined, { confined: true, affiliateCode: 'HKL' });

  // An unconfined role is untouched, whatever affiliate the user carries.
  assert.deepEqual(resolveAffiliateScope(false, 'HKL', false), UNCONFINED);

  // A platform owner acts above the customers and holds a synthesised matrix, so
  // no role row carries the flag for them.
  assert.deepEqual(resolveAffiliateScope(true, 'HKL', true), UNCONFINED);

  // An empty affiliate is the same as none: a blank column must not become a
  // predicate that matches blank rows.
  assert.deepEqual(resolveAffiliateScope(true, '', false), {
    confined: true,
    affiliateCode: null,
  });
  assert.deepEqual(resolveAffiliateScope(true, null, false), {
    confined: true,
    affiliateCode: null,
  });
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
  assert.deepEqual(
    affiliatePredicate({ confined: true, affiliateCode: 'HKL' }, 'wp.affiliate_code'),
    {
      clause: ' AND wp.affiliate_code = ?',
      args: ['HKL'],
    },
  );

  // Confined with none: the whole point. An empty predicate here would show a
  // user in a confined role the entire organisation, which is the exact failure
  // the feature exists to prevent, so it must match nothing instead.
  const closed = affiliatePredicate({ confined: true, affiliateCode: null }, 'wp.affiliate_code');
  assert.equal(closed.clause, ' AND 1 = 0');
  assert.deepEqual(closed.args, []);
  assert.ok(closed.clause.startsWith(' AND '), 'a predicate must be appendable to a WHERE clause');
});

test('affiliateVisible is the same rule for a single row', () => {
  assert.equal(affiliateVisible(UNCONFINED, 'HKL'), true);
  assert.equal(affiliateVisible(UNCONFINED, null), true);
  assert.equal(affiliateVisible({ confined: true, affiliateCode: 'HKL' }, 'HKL'), true);
  assert.equal(affiliateVisible({ confined: true, affiliateCode: 'HKL' }, 'OTHER'), false);
  // A record with no affiliate is not visible to a confined viewer: it belongs
  // to no affiliate, so it belongs to none of theirs.
  assert.equal(affiliateVisible({ confined: true, affiliateCode: 'HKL' }, null), false);
  assert.equal(affiliateVisible({ confined: true, affiliateCode: null }, 'HKL'), false);
  assert.equal(affiliateVisible({ confined: true, affiliateCode: null }, null), false);
});

test('the scope key separates cached aggregations that are genuinely different', () => {
  const all = affiliateScopeKey(UNCONFINED);
  const hkl = affiliateScopeKey({ confined: true, affiliateCode: 'HKL' });
  const other = affiliateScopeKey({ confined: true, affiliateCode: 'OTHER' });
  const none = affiliateScopeKey({ confined: true, affiliateCode: null });
  // Four distinct viewers, four distinct keys: a shared entry would hand one
  // viewer another's totals.
  assert.equal(new Set([all, hkl, other, none]).size, 4);
});
