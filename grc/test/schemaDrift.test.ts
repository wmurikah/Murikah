/**
 * The schema-drift guard (Build Prompt 61).
 *
 * THE PATTERN THIS EXISTS TO KILL. Twice now, and in smaller ways before that, a
 * hand-applied SQL script and the migration committed here have disagreed about
 * a column, and the code shipped reading the half the live database does not
 * have: `sub.round_number` answered 500 on the sidebar counts, and the work-paper
 * workflow was looked up under an `enum_type` no row carried. The typed column
 * layer already catches this for every query that goes through it, which is
 * most of them. What it cannot see is a raw identifier written inside a SQL
 * string, and that is exactly where both faults lived.
 *
 * WHAT IT CHECKS, MECHANICALLY. Every `sql:` template in the GRC source is
 * parsed for the tables it names after FROM, JOIN, UPDATE and INSERT INTO, and
 * for every `alias.column` whose alias that statement binds to a table. Each is
 * looked up in the committed dictionary (`grc/db/schema.md`, the same source the
 * typed columns and the smoke database are generated from). A table or column
 * that is not there fails here, in CI, rather than in production.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. Unqualified column names, expressions,
 * CTEs and anything it cannot resolve with certainty are skipped: a guard that
 * cries wolf is a guard somebody switches off. It is a spelling checker for
 * identifiers, not a type system, and it is meant to stay that way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTables, parseSchema } from './smoke/fakeTurso.ts';
import { seedDatabase } from './smoke/seed.ts';
import {
  WORK_PAPER_ENUM_TYPE,
  enumTypeForEntity,
} from '../../src/lib/grc/workflow/workPaperActions.ts';

const REPO = join(import.meta.dirname, '..', '..');
const SCHEMA_MD = join(REPO, 'grc', 'db', 'schema.md');

/** The GRC source that talks to the database. */
const ROOTS = [
  join(REPO, 'src', 'lib', 'grc'),
  join(REPO, 'src', 'pages', 'grc'),
  join(REPO, 'src', 'components', 'grc'),
];

/** Tables SQLite manages for us, which the dictionary deliberately omits. */
const MANAGED_TABLES = new Set([
  'work_papers_fts',
  'action_plans_fts',
  'sqlite_master',
  'pragma_table_info',
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|astro)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * The SQL fragments in a source file: the value of every `sql:` property, and
 * every `db.exec(`...`)` body. Template holes are left in place; the extractor
 * below only reads what it can resolve, and a hole is not one of those.
 */
function sqlFragments(source: string): string[] {
  const fragments: string[] = [];
  const re = /(?:sql:\s*|\.exec\(\s*)`([^`]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) fragments.push(m[1]);
  return fragments;
}

/** The tables a statement names, and the aliases it binds them to. */
function tablesAndAliases(sql: string): { tables: string[]; aliases: Map<string, string> } {
  const tables: string[] = [];
  const aliases = new Map<string, string>();
  // FROM/JOIN/UPDATE/INTO <table> [AS] [alias]. A '(' after the keyword is a
  // subquery, which has no table name to check here.
  const re =
    /\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO|INTO)\s+([a-z_][a-z0-9_]*)\b(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const table = m[1].toLowerCase();
    const alias = m[2]?.toLowerCase();
    tables.push(table);
    // Keywords that can follow a table name are not aliases.
    const NOT_ALIASES = new Set([
      'on',
      'where',
      'set',
      'values',
      'group',
      'order',
      'limit',
      'join',
      'left',
      'inner',
      'cross',
      'union',
      'having',
      'select',
      'and',
      'or',
    ]);
    if (alias && !NOT_ALIASES.has(alias)) aliases.set(alias, table);
    // A table used without an alias is addressable by its own name.
    aliases.set(table, table);
  }
  return { tables, aliases };
}

/** Every `alias.column` a statement writes, ignoring template holes. */
function qualifiedColumns(sql: string): { alias: string; column: string }[] {
  const out: { alias: string; column: string }[] = [];
  const re = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    out.push({ alias: m[1].toLowerCase(), column: m[2].toLowerCase() });
  }
  return out;
}

interface Finding {
  file: string;
  what: string;
}

test('every table a GRC query names exists in the committed schema', () => {
  const schema = parseSchema(SCHEMA_MD);
  const findings: Finding[] = [];

  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const source = readFileSync(file, 'utf8');
      for (const sql of sqlFragments(source)) {
        for (const table of tablesAndAliases(sql).tables) {
          if (MANAGED_TABLES.has(table) || schema.has(table)) continue;
          findings.push({
            file: relative(REPO, file).split(sep).join('/'),
            what: `table ${table}`,
          });
        }
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    `these queries name a table the committed schema does not have:\n${findings
      .map((f) => `  ${f.file}: ${f.what}`)
      .join('\n')}`,
  );
});

test('every qualified column a GRC query names exists on its table', () => {
  // This is the check that would have caught `sub.round_number`: the alias is
  // bound in the same statement, so the column can be resolved with certainty
  // and looked up in the dictionary.
  const schema = parseSchema(SCHEMA_MD);
  const findings: Finding[] = [];

  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const source = readFileSync(file, 'utf8');
      for (const sql of sqlFragments(source)) {
        const { aliases } = tablesAndAliases(sql);
        for (const { alias, column } of qualifiedColumns(sql)) {
          const table = aliases.get(alias);
          // An alias this statement does not bind is not ours to judge: it may
          // be a JS object, a function call or a table named in a hole.
          if (!table || MANAGED_TABLES.has(table)) continue;
          const columns = schema.get(table);
          if (!columns || columns.includes(column)) continue;
          findings.push({
            file: relative(REPO, file).split(sep).join('/'),
            what: `${table}.${column} (written as ${alias}.${column})`,
          });
        }
      }
    }
  }

  assert.deepEqual(
    findings,
    [],
    `these queries name a column the committed schema does not have:\n${findings
      .map((f) => `  ${f.file}: ${f.what}`)
      .join('\n')}`,
  );
});

test('the guard reads a real body of SQL, not an empty one', () => {
  // A guard whose extractor quietly stops matching passes for ever and protects
  // nothing, so the floor is asserted: these numbers only fall if the parser
  // breaks or the product loses most of its queries.
  let fragments = 0;
  let qualified = 0;
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      for (const sql of sqlFragments(readFileSync(file, 'utf8'))) {
        fragments += 1;
        qualified += qualifiedColumns(sql).length;
      }
    }
  }
  assert.ok(fragments > 150, `only ${fragments} SQL fragments were parsed`);
  assert.ok(qualified > 200, `only ${qualified} qualified columns were checked`);
});

test('every column a migration adds is recorded in the committed schema', () => {
  // The other half of the drift: a migration that adds a column the dictionary
  // never learned about leaves the typed layer, the smoke database and the live
  // one disagreeing, which is how the round_number fault arrived.
  const schema = parseSchema(SCHEMA_MD);
  const dir = join(REPO, 'grc', 'db', 'migrations');
  const findings: Finding[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(dir, name), 'utf8').replace(/^\s*--.*$/gm, '');
    for (const m of sql.matchAll(
      /ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+([a-z_][a-z0-9_]*)/gi,
    )) {
      const table = m[1].toLowerCase();
      const column = m[2].toLowerCase();
      if (schema.get(table)?.includes(column)) continue;
      findings.push({ file: `grc/db/migrations/${name}`, what: `${table}.${column}` });
    }
  }
  assert.deepEqual(
    findings,
    [],
    `these migrations add a column the dictionary does not record:\n${findings
      .map((f) => `  ${f.file}: ${f.what}`)
      .join('\n')}`,
  );
});

test('the workflow enums the code names exist in the seeded reference rows', () => {
  // The enum half of the drift. `status_transitions` keys every workflow in the
  // product by `enum_type`, and the code named the work-paper workflow in a
  // spelling no row carried, so the engine loaded nothing and refused every
  // move. The seed mirrors the live spelling, so this is the check that the two
  // still agree.
  const db = new DatabaseSync(':memory:');
  createTables(db, parseSchema(SCHEMA_MD));
  seedDatabase(db, 'http://storage.invalid');

  const rows = db
    .prepare(
      `SELECT COUNT(*) AS n FROM status_transitions
        WHERE TRIM(LOWER(enum_type)) = TRIM(LOWER(?))`,
    )
    .get(WORK_PAPER_ENUM_TYPE) as { n: number | bigint };
  assert.ok(
    Number(rows.n) > 0,
    `no status_transitions row is keyed by ${WORK_PAPER_ENUM_TYPE}; the code and the reference data disagree`,
  );

  // And the move that was refused resolves under the work paper's own workflow.
  const submit = db
    .prepare(
      `SELECT COUNT(*) AS n FROM status_transitions
        WHERE TRIM(LOWER(enum_type)) = TRIM(LOWER(?))
          AND from_status = 'Draft' AND to_status = 'Submitted'`,
    )
    .get(WORK_PAPER_ENUM_TYPE) as { n: number | bigint };
  assert.equal(Number(submit.n), 1, 'Draft to Submitted is defined once for a work paper');

  // The entity resolves its own workflow rather than a caller assuming one.
  assert.equal(enumTypeForEntity('work_paper'), WORK_PAPER_ENUM_TYPE);
  assert.equal(enumTypeForEntity('nothing_like_it'), null);
});

test('the guard actually bites', () => {
  // A guard nobody has seen fail is a guard nobody should trust, so this runs
  // the same extractors over the two statements that shipped broken.
  const schema = parseSchema(SCHEMA_MD);

  const missingColumn = `SELECT sub.no_such_column FROM requirement_submissions sub`;
  const { aliases } = tablesAndAliases(missingColumn);
  assert.equal(aliases.get('sub'), 'requirement_submissions', 'the alias resolves to its table');
  const bad = qualifiedColumns(missingColumn).find(
    (q) => !schema.get(aliases.get(q.alias) ?? '')?.includes(q.column),
  );
  assert.equal(bad?.column, 'no_such_column', 'an unknown column is found');

  const missingTable = `SELECT 1 FROM no_such_table t WHERE t.id = ?`;
  assert.ok(
    tablesAndAliases(missingTable).tables.some((t) => !schema.has(t)),
    'an unknown table is found',
  );

  // And the real column it was confused with is accepted, so the guard is not
  // simply refusing everything.
  assert.ok(
    schema.get('requirement_submissions')?.includes('round_number'),
    'round_number is in the committed schema, and the live database needs migration 007',
  );
});
