import assert from 'node:assert/strict';
import test from 'node:test';

import { NAV, PRIMARY_CTA } from '../../src/site.config.ts';

test('marketing navigation keeps the five-item information architecture', () => {
  assert.deepEqual(
    NAV.map((item) => item.label),
    ['Solutions', 'Platform', 'Pricing', 'Insights', 'About'],
  );
});

test('marketing dropdowns stay within the five-link choice limit', () => {
  for (const item of NAV) {
    assert.ok(
      (item.children?.length ?? 0) <= 5,
      `${item.label} has more than five dropdown destinations`,
    );
  }
});

test('pricing is a top-level destination and the header keeps one primary CTA', () => {
  assert.equal(NAV.find((item) => item.label === 'Pricing')?.href, '/pricing');
  assert.ok(NAV.every((item) => item.children?.every((child) => child.href !== '/pricing') ?? true));
  assert.deepEqual(PRIMARY_CTA, {
    label: 'Discuss your requirements',
    href: '/contact',
  });
});
