// Introspect the live Hass CMS Turso database and regenerate the ground-truth
// snapshot: cms/db/schema.sql (DDL) and cms/db/schema.md (the column dictionary).
// Then run `pnpm cms:db:columns` to regenerate src/lib/cms/schema/columns.ts.
//
// Run: pnpm cms:db:introspect  (reads TURSO_CMS_* from .dev.vars)
//
// This is the §1 discipline made repeatable: the typed layer is generated from
// the live schema, so a wrong column name fails `pnpm build`, never a request.
// It is a build-time dev tool and ships nothing to the Worker. No secrets are
// written to the repo; only the schema shape.
import { createClient } from '@libsql/client';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const url = process.env.TURSO_CMS_DATABASE_URL;
const authToken = process.env.TURSO_CMS_AUTH_TOKEN;
if (!url || !authToken) {
  console.error(
    'Set TURSO_CMS_DATABASE_URL and TURSO_CMS_AUTH_TOKEN (in .dev.vars) to introspect.',
  );
  process.exit(1);
}

// An FTS virtual table and its shadow tables are excluded from the typed layer.
const isFtsShadow = (name) => /_fts($|_(data|idx|docsize|config|content))/.test(name);
const stamp = new Date().toISOString().slice(0, 10);

const db = createClient({ url, authToken });
const master = await db.execute(
  `SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'
    ORDER BY name`,
);
const tables = master.rows.filter(
  (r) => r.type === 'table' && !/VIRTUAL TABLE/i.test(r.sql ?? '') && !isFtsShadow(r.name),
);
const indexes = master.rows.filter((r) => r.type === 'index' && r.sql && !isFtsShadow(r.tbl_name));

// Columns per table, in definition order.
const colsByTable = {};
for (const t of tables) {
  const info = await db.execute(`PRAGMA table_info(${JSON.stringify(t.name)})`);
  colsByTable[t.name] = info.rows.map((r) => String(r.name));
}

let sql = `-- Hass CMS schema snapshot.
-- Introspected from the live Turso CMS database (SELECT sql FROM sqlite_master)
-- on ${stamp}. This is the ground truth the typed column layer
-- (src/lib/cms/schema/columns.ts) is generated from: a query that names a column
-- not present here fails \`pnpm build\`, never at runtime. Regenerate with
-- \`pnpm cms:db:introspect\` then \`pnpm cms:db:columns\`. FTS shadow tables excluded.

`;
for (const t of tables) sql += `${t.sql.trim()};\n\n`;
sql += '-- Indexes\n';
for (const i of indexes) sql += `${i.sql.trim()};\n`;
writeFileSync(join(here, 'schema.sql'), sql);

let md = `# Hass CMS schema dictionary (ground truth)

Introspected from the live Turso CMS database on ${stamp} (pragma_table_info per
table). One line per table, columns in definition order. This drives
\`cms/db/gen-columns.mjs\`, which regenerates \`src/lib/cms/schema/columns.ts\`. A
column referenced in code that is not listed here is a compile error, so schema
drift fails the build rather than a request. FTS shadow tables are excluded.
Regenerate with \`pnpm cms:db:introspect\` then \`pnpm cms:db:columns\`.

`;
for (const t of tables) md += `- **${t.name}**: ${colsByTable[t.name].join(', ')}\n`;
writeFileSync(join(here, 'schema.md'), md);

console.log(
  `Wrote schema.sql and schema.md for ${tables.length} tables. Now run pnpm cms:db:columns.`,
);
