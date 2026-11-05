import type { Client } from '@libsql/client';
import { migrations } from './migrations/index.ts';
import { verifySchemaContract } from './schema-contract.ts';

const HISTORY_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`;

export interface MigrationRun {
  applied: string[];
  alreadyApplied: string[];
}

export async function runMigrations(client: Client): Promise<MigrationRun> {
  await client.execute('PRAGMA foreign_keys = ON');
  await client.execute(HISTORY_SQL);
  const history = await client.execute('SELECT id, checksum FROM schema_migrations ORDER BY id');
  const appliedChecksums = new Map(
    history.rows.map((row) => [String(row.id), String(row.checksum)]),
  );
  const result: MigrationRun = { applied: [], alreadyApplied: [] };

  for (const migration of migrations) {
    const recorded = appliedChecksums.get(migration.id);
    if (recorded) {
      if (recorded !== migration.checksum) {
        throw new Error(
          `Migration ${migration.id} was modified after it was applied. Restore the original migration and add a new numbered migration.`,
        );
      }
      result.alreadyApplied.push(migration.id);
      continue;
    }

    const tx = await client.transaction('write');
    try {
      await migration.up(tx);
      await tx.execute({
        sql: `INSERT INTO schema_migrations (id, description, checksum) VALUES (?, ?, ?)`,
        args: [migration.id, migration.description, migration.checksum],
      });
      await tx.commit();
      result.applied.push(migration.id);
    } catch (error) {
      await tx.rollback();
      throw new Error(
        `Migration ${migration.id} (${migration.description}) failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  await verifySchemaContract(client);
  return result;
}
