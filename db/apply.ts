/**
 * Apply db/schema.sql to the configured Turso database.
 *
 * Run:  pnpm db:apply
 * Uses the shared loader (shell env first, then .dev.vars) and the shared Node
 * libSQL client. Replaces the need for `turso db shell murikah < db/schema.sql`.
 *
 * The schema uses CREATE TABLE IF NOT EXISTS throughout, so applying it
 * repeatedly is safe and idempotent.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbClient } from './_env';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, 'schema.sql'), 'utf8');

/** Split into individual statements (drop full-line -- comments). */
function splitStatements(sql: string): string[] {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const statements = splitStatements(schema);
const client = createDbClient();

try {
  // Run the whole file in one call.
  await client.executeMultiple(schema);
  console.log(`✓ Applied db/schema.sql (${statements.length} statements).`);
} catch (error) {
  console.error('✗ Failed to apply the schema.');
  // Re-run statement by statement to identify the failing one (safe: the schema
  // is idempotent, so already-applied statements just no-op).
  for (const statement of statements) {
    try {
      await client.execute(statement);
    } catch (statementError) {
      console.error('\nFailing statement:\n' + statement + '\n');
      console.error(
        statementError instanceof Error ? statementError.message : String(statementError),
      );
      process.exit(1);
    }
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
