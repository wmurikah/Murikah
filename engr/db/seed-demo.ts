/**
 * Demo actors for the assignment and execution flow, so the happy path runs end
 * to end with distinct logins. Attaches to an organisation created by the tenant
 * bootstrap (default slug "demo") and its HQ station and GEN category.
 *
 * Run:  pnpm db:engr:seed-demo   (after pnpm db:engr:bootstrap)
 * Idempotent: re-running reuses the rows it created.
 *
 * Reads from the environment, never hardcoded:
 *   TURSO_ENGR_DATABASE_URL, TURSO_ENGR_AUTH_TOKEN
 *   ENGR_DEMO_PASSWORD   (required, used for every demo user)
 *   ENGR_ORG_SLUG        (optional, default "demo")
 *
 * Creates, all in the org: an engineer, a contractor portal user with a
 * pre-qualified contractor covering HQ and the GEN category, a technician portal
 * user with a technician on that contractor, a station manager set on HQ, a
 * default SLA, and an org rate card with one GEN rate item.
 */
import { createClient } from '@libsql/client/web';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../../src/lib/engr/auth/password.ts';

const url = process.env.TURSO_ENGR_DATABASE_URL;
const authToken = process.env.TURSO_ENGR_AUTH_TOKEN;
if (!url) {
  console.error('✗ TURSO_ENGR_DATABASE_URL is not set. Add it to .dev.vars or your environment.');
  process.exit(1);
}
const demoPassword = process.env.ENGR_DEMO_PASSWORD ?? '';
const orgSlug = (process.env.ENGR_ORG_SLUG ?? 'demo').trim().toLowerCase();
if (!demoPassword) {
  console.error('✗ Set ENGR_DEMO_PASSWORD (used for every demo user) before running.');
  process.exit(1);
}

const newId = (): string => randomUUID().replace(/-/g, '');
const client = createClient({ url, authToken });
await client.execute('PRAGMA foreign_keys = ON;');

async function one(
  sql: string,
  args: (string | number | null)[],
): Promise<Record<string, unknown> | undefined> {
  const res = await client.execute({ sql, args });
  return res.rows[0] as Record<string, unknown> | undefined;
}

const org = await one(`SELECT id FROM organisations WHERE slug = ? LIMIT 1`, [orgSlug]);
if (!org) throw new Error(`Organisation "${orgSlug}" not found. Run pnpm db:engr:bootstrap first.`);
const orgId = String(org.id);

const hqStation = await one(`SELECT id FROM stations WHERE org_id = ? AND code = 'HQ' LIMIT 1`, [
  orgId,
]);
if (!hqStation) throw new Error('HQ station not found. Run pnpm db:engr:bootstrap first.');
const stationId = String(hqStation.id);

const genCategory = await one(
  `SELECT id FROM asset_categories WHERE org_id = ? AND code = 'GEN' LIMIT 1`,
  [orgId],
);
const categoryId = genCategory ? String(genCategory.id) : null;

const passwordHash = await hashPassword(demoPassword);

async function ensureUser(email: string, fullName: string, roleCode: string): Promise<string> {
  const lower = email.trim().toLowerCase();
  const existing = await one(`SELECT id FROM users WHERE org_id = ? AND email = ? LIMIT 1`, [
    orgId,
    lower,
  ]);
  let userId: string;
  if (existing) {
    userId = String(existing.id);
  } else {
    userId = newId();
    await client.execute({
      sql: `INSERT INTO users (id, org_id, full_name, email, password_hash, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      args: [userId, orgId, fullName, lower, passwordHash],
    });
  }
  const role = await one(`SELECT id FROM roles WHERE code = ? AND org_id IS NULL LIMIT 1`, [
    roleCode,
  ]);
  if (!role) throw new Error(`System role ${roleCode} not found. Run pnpm db:engr:seed first.`);
  await client.execute({
    sql: `INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)`,
    args: [userId, String(role.id)],
  });
  return userId;
}

await ensureUser('engineer@demo.local', 'Demo Engineer', 'ENGINEER');
const contractorUserId = await ensureUser('contractor@demo.local', 'Demo Contractor', 'CONTRACTOR');
const contractor2UserId = await ensureUser(
  'contractor2@demo.local',
  'Demo Contractor Two',
  'CONTRACTOR',
);
const technicianUserId = await ensureUser('technician@demo.local', 'Demo Technician', 'TECHNICIAN');
const stationManagerId = await ensureUser(
  'station@demo.local',
  'Demo Station Manager',
  'STATION_MANAGER',
);
// Owner acts as the procurement approver, distinct from the engineer who awards.
await ensureUser('owner@demo.local', 'Demo Owner', 'OWNER');

// Station manager owns HQ.
await client.execute({
  sql: `UPDATE stations SET station_manager_id = ? WHERE org_id = ? AND code = 'HQ'`,
  args: [stationManagerId, orgId],
});

// Pre-qualified contractor, reused by name, covering HQ and the GEN category.
const contractorName = 'Demo Contractor Ltd';
let contractorId: string;
const existingContractor = await one(
  `SELECT id FROM contractors WHERE org_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1`,
  [orgId, contractorName],
);
if (existingContractor) {
  contractorId = String(existingContractor.id);
  await client.execute({
    sql: `UPDATE contractors SET is_prequalified = 1, status = 'ACTIVE', portal_user_id = ? WHERE id = ? AND org_id = ?`,
    args: [contractorUserId, contractorId, orgId],
  });
} else {
  contractorId = newId();
  await client.execute({
    sql: `INSERT INTO contractors (id, org_id, name, is_prequalified, portal_user_id, status)
          VALUES (?, ?, ?, 1, ?, 'ACTIVE')`,
    args: [contractorId, orgId, contractorName, contractorUserId],
  });
}
await client.execute({
  sql: `INSERT OR IGNORE INTO contractor_stations (org_id, contractor_id, station_id) VALUES (?, ?, ?)`,
  args: [orgId, contractorId, stationId],
});
if (categoryId) {
  await client.execute({
    sql: `INSERT OR IGNORE INTO contractor_categories (org_id, contractor_id, category_id) VALUES (?, ?, ?)`,
    args: [orgId, contractorId, categoryId],
  });
}

// Technician on that contractor, reused by portal user.
const existingTech = await one(
  `SELECT id FROM technicians WHERE org_id = ? AND portal_user_id = ? AND deleted_at IS NULL LIMIT 1`,
  [orgId, technicianUserId],
);
if (existingTech) {
  await client.execute({
    sql: `UPDATE technicians SET contractor_id = ?, status = 'ACTIVE' WHERE id = ? AND org_id = ?`,
    args: [contractorId, String(existingTech.id), orgId],
  });
} else {
  await client.execute({
    sql: `INSERT INTO technicians (id, org_id, contractor_id, full_name, portal_user_id, status)
          VALUES (?, ?, ?, 'Demo Technician', ?, 'ACTIVE')`,
    args: [newId(), orgId, contractorId, technicianUserId],
  });
}

// Second pre-qualified contractor covering HQ and GEN, so an RFQ can compare
// more than one quote.
const contractor2Name = 'Demo Contractor Two Ltd';
let contractor2Id: string;
const existingContractor2 = await one(
  `SELECT id FROM contractors WHERE org_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1`,
  [orgId, contractor2Name],
);
if (existingContractor2) {
  contractor2Id = String(existingContractor2.id);
  await client.execute({
    sql: `UPDATE contractors SET is_prequalified = 1, status = 'ACTIVE', portal_user_id = ? WHERE id = ? AND org_id = ?`,
    args: [contractor2UserId, contractor2Id, orgId],
  });
} else {
  contractor2Id = newId();
  await client.execute({
    sql: `INSERT INTO contractors (id, org_id, name, is_prequalified, portal_user_id, status)
          VALUES (?, ?, ?, 1, ?, 'ACTIVE')`,
    args: [contractor2Id, orgId, contractor2Name, contractor2UserId],
  });
}
await client.execute({
  sql: `INSERT OR IGNORE INTO contractor_stations (org_id, contractor_id, station_id) VALUES (?, ?, ?)`,
  args: [orgId, contractor2Id, stationId],
});
if (categoryId) {
  await client.execute({
    sql: `INSERT OR IGNORE INTO contractor_categories (org_id, contractor_id, category_id) VALUES (?, ?, ?)`,
    args: [orgId, contractor2Id, categoryId],
  });
}

// Default SLA.
await client.execute({
  sql: `INSERT OR IGNORE INTO slas (id, org_id, name, response_hours, resolution_hours, is_default)
        VALUES (?, ?, 'Standard', 4, 48, 1)`,
  args: [newId(), orgId],
});

// Procurement threshold: an award at or below KES 50,000 (5,000,000 minor)
// proceeds directly; above it a second approver signs off.
await client.execute({
  sql: `INSERT OR IGNORE INTO org_settings (org_id, key, value_json)
        VALUES (?, 'procurement_threshold_minor', '5000000')`,
  args: [orgId],
});

// Org rate card with one GEN rate item, so spares can be priced.
const rateCardName = 'Demo rate card';
let rateCardId: string;
const existingCard = await one(`SELECT id FROM rate_cards WHERE org_id = ? AND name = ? LIMIT 1`, [
  orgId,
  rateCardName,
]);
if (existingCard) {
  rateCardId = String(existingCard.id);
} else {
  rateCardId = newId();
  await client.execute({
    sql: `INSERT INTO rate_cards (id, org_id, name, status) VALUES (?, ?, ?, 'ACTIVE')`,
    args: [rateCardId, orgId, rateCardName],
  });
}
const rateItemDesc = 'Generator service kit';
const existingItem = await one(
  `SELECT id FROM rate_items WHERE org_id = ? AND rate_card_id = ? AND description = ? LIMIT 1`,
  [orgId, rateCardId, rateItemDesc],
);
if (!existingItem) {
  await client.execute({
    sql: `INSERT INTO rate_items (id, org_id, rate_card_id, category_id, description, unit, unit_rate_minor)
          VALUES (?, ?, ?, ?, ?, 'each', 350000)`,
    args: [newId(), orgId, rateCardId, categoryId, rateItemDesc],
  });
}

console.log('');
console.log('✓ Engineering Rhythm demo actors ready in org:', orgSlug);
console.log('  Sign in (all use ENGR_DEMO_PASSWORD):');
console.log('    engineer@demo.local     (ENGINEER)');
console.log('    contractor@demo.local   (CONTRACTOR, portal for Demo Contractor Ltd)');
console.log('    contractor2@demo.local  (CONTRACTOR, portal for Demo Contractor Two Ltd)');
console.log('    technician@demo.local   (TECHNICIAN)');
console.log('    station@demo.local      (STATION_MANAGER, owns HQ)');
console.log('    owner@demo.local        (OWNER, procurement approver)');
console.log('  Predefined-rate flow: accept a request, then assign a contractor.');
console.log('  RFQ flow: accept a request, raise an RFQ, invite both contractors,');
console.log('    submit quotes, then award. Above KES 50,000 the owner signs off.');
process.exit(0);
