/**
 * Where a signed-in user lands, and why it is a permission that decides.
 *
 * The executive dashboard is the first screen for the people whose job starts
 * with "where should we be looking", and Home is the first screen for everyone
 * else. Which of those a person gets is read from EXECUTIVE.DASHBOARD.VIEW and
 * from nothing else: no email address, no user id and no job title takes part,
 * so the rule cannot become a list of names that somebody maintains by hand.
 *
 * The code is added by docs/cms/executive/08_add_executive_permission.sql,
 * which the operator runs. Until it is run nobody holds it and everybody lands
 * on Home, which is the behaviour that existed before this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { homeFor, EXECUTIVE_HOME } from '../../src/lib/cms/routes.ts';
import { EXECUTIVE_DASHBOARD_VIEW } from '../../src/lib/cms/permissions.ts';

/**
 * Where a user lands after signing in, decided by a permission and nothing else.
 *
 * The rule these assert: `homeFor` sends an EXTERNAL user to the portal
 * whatever they hold, sends an internal user who holds
 * EXECUTIVE.DASHBOARD.VIEW to the executive dashboard, and sends everybody
 * else to Home. No email address, no user id and no job title participates,
 * which is what stops this becoming a list of people that somebody has to
 * maintain by hand.
 */
test('a user holding the executive code lands on the executive dashboard', () => {
  assert.equal(homeFor('INTERNAL', [EXECUTIVE_DASHBOARD_VIEW]), EXECUTIVE_HOME);
});

test('a user without the executive code lands on Home', () => {
  // Holding every code the page COMPOSES from is deliberately not enough: the
  // nav uses that any-of-four rule to decide who may open the page, and this
  // is the different question of whose home it is.
  assert.equal(
    homeFor('INTERNAL', [
      'ORDERS.SALES_ORDER.VIEW',
      'ORDERS.PURCHASE_ORDER.VIEW',
      'CRM.OPPORTUNITIES.VIEW',
      'SERVICE.CASES.VIEW',
    ]),
    '/app',
  );
  assert.equal(homeFor('INTERNAL', []), '/app');
});

test('an external user goes to the portal even holding the executive code', () => {
  assert.equal(homeFor('EXTERNAL', [EXECUTIVE_DASHBOARD_VIEW]), '/portal');
});

test('the landing rule is unchanged for a caller that supplies no permissions', () => {
  // Every call site that knew only a user type keeps its previous answer, so
  // adding the code cannot land somebody somewhere new by accident.
  assert.equal(homeFor('INTERNAL'), '/app');
  assert.equal(homeFor('EXTERNAL'), '/portal');
});
