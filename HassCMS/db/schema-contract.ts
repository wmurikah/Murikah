/** Generate/check the reviewed manifest, or inspect live metadata without writes. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectSchema } from '../src/lib/cms/schema/inspect.ts';

const target = new URL('../src/lib/cms/schema/contract.json', import.meta.url);
const mode = process.argv[2] ?? '--check';
if (process.argv.length > 3 || !['--generate', '--check', '--live'].includes(mode))
  throw new Error(
    'Usage: node --experimental-strip-types db/schema-contract.ts [--generate|--check|--live]',
  );

if (mode === '--live') {
  const { createClient } = await import('@libsql/client/web');
  const { checkSchemaCompatibility } = await import('../src/lib/cms/schema/compatibility.ts');
  const url = process.env.TURSO_CMS_DATABASE_URL,
    authToken = process.env.TURSO_CMS_AUTH_TOKEN;
  if (!url || !authToken)
    throw new Error('Configure TURSO_CMS_DATABASE_URL and TURSO_CMS_AUTH_TOKEN');
  const db = createClient({ url, authToken });
  try {
    const result = await checkSchemaCompatibility(db);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.error('Schema metadata could not be checked; verify connection and permissions.');
    process.exitCode = 1;
  } finally {
    db.close();
  }
} else {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('./schema/cms.sql', import.meta.url), 'utf8'));
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => String(r.name));
    const adapter = {
      async execute(stmt: { sql: string; args?: unknown[] }) {
        return { rows: db.prepare(stmt.sql).all(...((stmt.args ?? []) as never[])) };
      },
    };
    const { format, resolveConfig } = await import('prettier');
    const manifest = await format(JSON.stringify(await inspectSchema(adapter as never, tables)), {
      ...(await resolveConfig(fileURLToPath(target))),
      parser: 'json',
    });
    if (mode === '--generate') {
      writeFileSync(target, manifest);
      console.log(`Generated ${tables.length} table contracts.`);
    } else if (readFileSync(target, 'utf8') !== manifest) {
      console.error(
        'Schema manifest is stale. Review db/schema/cms.sql, then run npm run db:schema:generate and commit both.',
      );
      process.exitCode = 1;
    } else console.log(`Reviewed schema and ${tables.length} table contracts agree.`);
  } finally {
    db.close();
  }
}
