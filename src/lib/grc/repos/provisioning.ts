/**
 * Per-customer provisioning: when a new organisation is created, seed its
 * defaults so every tenant starts configured. This wires the pure statement
 * builder (provisioningDefaults.ts) to the real reference dropdowns (dropdowns.ts,
 * the single source of the dropdown defaults) and runs the inserts in one
 * transactional batch (all or nothing): the Phase 1 config, the reference
 * dropdowns, a first SUPER_ADMIN user, a trial subscription, and the
 * organisation's own copy of the platform-default permission matrix.
 */
import type { Client } from '@libsql/client/web';
import { flushOrganisation } from '@grc/cache/invalidate';
import { inheritPlatformDefaultsStatement } from './permissionsAdmin';
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
  await db.batch(
    [
      ...buildProvisioningStatements(ids, input, dropdownEntries()),
      // The new organisation gets its own copy of the platform-default grants
      // (Build Prompt 44), in the same batch as the organisation row it
      // references. A copy rather than a live fallback, so the first
      // administrator to open the access-control screen sees a real editable set
      // and a later change to the defaults cannot move an existing customer's
      // access underneath them. It stays here rather than in the pure builder so
      // it goes through the typed column layer.
      inheritPlatformDefaultsStatement(ids.organizationId),
    ],
    'write',
  );
  // A brand new organisation should never inherit anything, and an id that was
  // provisioned, removed and provisioned again must not find an old entry
  // waiting. Clearing the namespace costs one call and removes the question.
  await flushOrganisation(db, ids.organizationId);
  return ids;
}
