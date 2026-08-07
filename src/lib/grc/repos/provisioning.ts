/**
 * Per-customer provisioning: when a new organisation is created, seed its
 * defaults so every tenant starts configured. This wires the pure statement
 * builder (provisioningDefaults.ts) to the real reference dropdowns (dropdowns.ts,
 * the single source of the dropdown defaults) and runs the inserts in one
 * transactional batch (all or nothing): the Phase 1 config, the reference
 * dropdowns, a first SUPER_ADMIN user and a trial subscription.
 */
import type { Client } from '@libsql/client/web';
import { flushOrganisation } from '@grc/cache/invalidate';
import { DROPDOWN_KEYS, DROPDOWN_DEFAULTS } from './dropdowns';
import {
  buildProvisioningStatements,
  type ProvisionInput,
  type ProvisionIds,
} from './provisioningDefaults';

export {
  PHASE1_CONFIG_DEFAULTS,
  TRIAL_PLAN_CODE,
  TRIAL_STATUS,
  buildProvisioningStatements,
  type ProvisionInput,
  type ProvisionIds,
  type Statement,
} from './provisioningDefaults';

/** The reference dropdowns as config entries, from the single source of defaults. */
function dropdownEntries(): [string, string][] {
  return [
    [DROPDOWN_KEYS.riskRatings, JSON.stringify(DROPDOWN_DEFAULTS.riskRatings)],
    [DROPDOWN_KEYS.classification, JSON.stringify(DROPDOWN_DEFAULTS.classification)],
    [DROPDOWN_KEYS.controlType, JSON.stringify(DROPDOWN_DEFAULTS.controlType)],
    [DROPDOWN_KEYS.controlFrequency, JSON.stringify(DROPDOWN_DEFAULTS.controlFrequency)],
  ];
}

/**
 * Provision a new organisation in one transactional batch. Returns the new ids.
 * The caller supplies a hashed admin password (never the plain text).
 */
export async function provisionOrganization(
  db: Client,
  input: ProvisionInput,
): Promise<ProvisionIds> {
  const ids: ProvisionIds = {
    organizationId: crypto.randomUUID(),
    adminUserId: crypto.randomUUID(),
  };
  await db.batch(buildProvisioningStatements(ids, input, dropdownEntries()), 'write');
  // A brand new organisation should never inherit anything, and an id that was
  // provisioned, removed and provisioned again must not find an old entry
  // waiting. Clearing the namespace costs one call and removes the question.
  await flushOrganisation(db, ids.organizationId);
  return ids;
}
