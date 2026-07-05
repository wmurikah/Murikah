/**
 * Per-customer provisioning. The statement builder and the dropdown defaults are
 * pure, import-free leaves, so node strips types and runs them directly. These
 * pin that a new organisation is seeded with its config, the reference dropdowns,
 * a first SUPER_ADMIN and a trial subscription, in one batch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProvisioningStatements,
  PHASE1_CONFIG_DEFAULTS,
  TRIAL_PLAN_CODE,
} from '../../src/lib/grc/repos/provisioningDefaults.ts';
import { DROPDOWN_KEYS, DROPDOWN_DEFAULTS } from '../../src/lib/grc/repos/dropdownDefaults.ts';

const ids = { organizationId: 'ORG1', adminUserId: 'USER1' };
const input = {
  organizationName: 'Acme Audit',
  adminEmail: 'admin@acme.test',
  adminName: 'Ada Admin',
  adminPasswordHash: 'pbkdf2$60000$c2FsdA==$aGFzaA==',
  now: new Date('2026-07-05T00:00:00.000Z'),
};
// The reference dropdowns, injected exactly as provisioning.ts wires them.
const dropdownEntries: [string, string][] = [
  [DROPDOWN_KEYS.riskRatings, JSON.stringify(DROPDOWN_DEFAULTS.riskRatings)],
  [DROPDOWN_KEYS.classification, JSON.stringify(DROPDOWN_DEFAULTS.classification)],
  [DROPDOWN_KEYS.controlType, JSON.stringify(DROPDOWN_DEFAULTS.controlType)],
  [DROPDOWN_KEYS.controlFrequency, JSON.stringify(DROPDOWN_DEFAULTS.controlFrequency)],
];

test('provisioning seeds the org, a SUPER_ADMIN, a trial and the config', () => {
  const statements = buildProvisioningStatements(ids, input, dropdownEntries);
  const sql = statements.map((s) => s.sql).join('\n');

  assert.ok(sql.includes('INSERT INTO organizations'));
  assert.ok(sql.includes('INSERT INTO users'));
  assert.ok(sql.includes('INSERT INTO subscriptions'));
  assert.ok(sql.includes('INSERT INTO config'));

  // The admin is a SUPER_ADMIN and the subscription is the trial plan.
  const userStmt = statements.find((s) => s.sql.includes('INTO users'));
  assert.ok(userStmt && userStmt.sql.includes("'SUPER_ADMIN'"));
  assert.ok(userStmt && userStmt.args.includes(input.adminPasswordHash));
  const subStmt = statements.find((s) => s.sql.includes('INTO subscriptions'));
  assert.ok(subStmt && subStmt.args.includes(TRIAL_PLAN_CODE));

  // The org id threads through every row.
  assert.ok(statements.every((s) => s.args.includes('ORG1')));
});

test('provisioning seeds every Phase 1 config key and the reference dropdowns', () => {
  const statements = buildProvisioningStatements(ids, input, dropdownEntries);
  const configKeys = statements
    .filter((s) => s.sql.includes('INTO config'))
    .map((s) => String(s.args[1]));

  for (const key of Object.keys(PHASE1_CONFIG_DEFAULTS)) {
    assert.ok(configKeys.includes(key), `missing config key ${key}`);
  }
  for (const key of Object.values(DROPDOWN_KEYS)) {
    assert.ok(configKeys.includes(key), `missing dropdown ${key}`);
  }
  // The dropdown values are seeded as JSON arrays.
  const risk = statements.find((s) => s.args[1] === DROPDOWN_KEYS.riskRatings);
  assert.ok(risk && String(risk.args[2]).startsWith('['));
});
