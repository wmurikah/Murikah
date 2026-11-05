import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Migration, MigrationDatabase } from './types.ts';

const additions: Record<string, Record<string, string>> = {
  organisations: {
    parent_org_id: 'TEXT REFERENCES organisations(id)',
  },
  regions: {
    currency: "TEXT NOT NULL DEFAULT 'KES'",
  },
  users: {
    is_platform_owner: 'INTEGER NOT NULL DEFAULT 0',
  },
  lpos: {
    region_id: 'TEXT REFERENCES regions(id)',
    notes: 'TEXT',
    subtotal_minor: 'INTEGER NOT NULL DEFAULT 0',
    mileage_minor: 'INTEGER NOT NULL DEFAULT 0',
    approved_by: 'TEXT REFERENCES users(id)',
    approved_at: 'TEXT',
    issued_by: 'TEXT REFERENCES users(id)',
    issued_at: 'TEXT',
    sealed_hash: 'TEXT',
    sealed_at: 'TEXT',
    version: 'INTEGER NOT NULL DEFAULT 1',
    supersedes_id: 'TEXT REFERENCES lpos(id)',
    superseded_by_id: 'TEXT REFERENCES lpos(id)',
    cancelled_at: 'TEXT',
    cancel_reason: 'TEXT',
  },
};

const lpoLinesSql = `CREATE TABLE IF NOT EXISTS lpo_lines (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  org_id        TEXT NOT NULL REFERENCES organisations(id),
  lpo_id        TEXT NOT NULL REFERENCES lpos(id),
  work_order_id TEXT REFERENCES work_orders(id),
  wo_no         TEXT,
  station_id    TEXT REFERENCES stations(id),
  station_name  TEXT,
  asset_id      TEXT REFERENCES assets(id),
  asset_tag     TEXT,
  category_id   TEXT REFERENCES asset_categories(id),
  category_name TEXT,
  sla_id        TEXT REFERENCES slas(id),
  sla_name      TEXT,
  description   TEXT,
  amount_minor  INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'KES',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`;

const indexSql = [
  'CREATE INDEX IF NOT EXISTS ix_lpo_lines_lpo ON lpo_lines(lpo_id)',
  'CREATE INDEX IF NOT EXISTS ix_lpos_region ON lpos(region_id)',
  'CREATE INDEX IF NOT EXISTS ix_org_parent ON organisations(parent_org_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_roles_system ON roles(code) WHERE org_id IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users(email)',
];

async function columns(db: MigrationDatabase, table: string): Promise<Set<string>> {
  const result = await db.execute(`PRAGMA table_info(${table})`);
  return new Set(result.rows.map((row) => String(row.name)));
}

async function rejectAmbiguousGlobalIdentities(db: MigrationDatabase): Promise<void> {
  const duplicateEmails = await db.execute({
    sql: `SELECT email, COUNT(*) AS n FROM users
        GROUP BY email HAVING COUNT(*) > 1 LIMIT 1`,
    args: [],
  });
  if (duplicateEmails.rows[0]) {
    throw new Error(
      `Cannot enforce global user email identity: ${String(duplicateEmails.rows[0].email)} is assigned to more than one user. Resolve the duplicate before rerunning migration 002.`,
    );
  }

  const duplicateSystemRoles = await db.execute({
    sql: `SELECT code, COUNT(*) AS n FROM roles
           WHERE org_id IS NULL
        GROUP BY code HAVING COUNT(*) > 1 LIMIT 1`,
    args: [],
  });
  if (duplicateSystemRoles.rows[0]) {
    throw new Error(
      `Cannot enforce system-role uniqueness: ${String(duplicateSystemRoles.rows[0].code)} occurs more than once. Resolve the duplicate before rerunning migration 002.`,
    );
  }
}

export const liveSchemaReconciliation: Migration = {
  id: '002',
  description: 'Reconcile affiliate, platform owner, currency and versioned LPO schema',
  checksum: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  async up(db) {
    for (const [table, definitions] of Object.entries(additions)) {
      const existing = await columns(db, table);
      for (const [name, definition] of Object.entries(definitions)) {
        if (!existing.has(name)) {
          await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
        }
      }
    }

    await db.execute(lpoLinesSql);
    await rejectAmbiguousGlobalIdentities(db);
    for (const sql of indexSql) await db.execute(sql);
  },
};
