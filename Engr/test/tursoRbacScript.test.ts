import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { migrations } from '../db/migrations/index.ts';
import { comprehensiveRbac, RBAC_PERMISSIONS } from '../db/migrations/006_comprehensive_rbac.ts';
import { queryIndexes } from '../db/migrations/007_query_indexes.ts';
import { invoicesAndAssetMovements } from '../db/migrations/008_invoices_asset_movements.ts';
import { verifySchemaContract } from '../db/schema-contract.ts';

test('Turso Web RBAC script upgrades migration 005 without transaction keywords or drift', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'engr-turso-rbac-'));
  const client = createClient({ url: `file:${join(directory, 'test.db')}` });
  try {
    await client.execute(`CREATE TABLE schema_migrations (
      id TEXT PRIMARY KEY, description TEXT NOT NULL, checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`);
    for (const migration of migrations.slice(0, 5)) {
      await migration.up(client);
      await client.execute({
        sql: `INSERT INTO schema_migrations (id, description, checksum) VALUES (?, ?, ?)`,
        args: [migration.id, migration.description, migration.checksum],
      });
    }

    const apply = readFileSync(
      new URL('../db/turso-web/14_apply_comprehensive_rbac.sql', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(apply, /^\s*(?:BEGIN|COMMIT|ROLLBACK|END)\b/im);
    assert.doesNotMatch(apply, /__CHECKSUM__/);
    await client.executeMultiple(apply);
    await queryIndexes.up(client);
    await invoicesAndAssetMovements.up(client);
    await verifySchemaContract(client);

    const history = await client.execute(`SELECT checksum FROM schema_migrations WHERE id = '006'`);
    assert.equal(history.rows.length, 1);
    assert.equal(history.rows[0].checksum, comprehensiveRbac.checksum);
    const total = Number((await client.execute(`SELECT COUNT(*) AS n FROM permissions`)).rows[0].n);
    assert.equal(total, RBAC_PERMISSIONS.length);
    const owner = Number(
      (
        await client.execute(`SELECT COUNT(*) AS n FROM role_permissions rp
          JOIN roles r ON r.id = rp.role_id WHERE r.org_id IS NULL AND r.code = 'OWNER'`)
      ).rows[0].n,
    );
    assert.equal(owner, total);
    const check = readFileSync(
      new URL('../db/turso-web/13_check_comprehensive_rbac.sql', import.meta.url),
      'utf8',
    );
    await client.executeMultiple(check);
  } finally {
    client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
