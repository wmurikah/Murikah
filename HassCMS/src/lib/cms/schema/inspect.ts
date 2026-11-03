import type { Client } from '@libsql/client/web';

export type SchemaDb = Pick<Client, 'execute'>;
type Row = Record<string, unknown>;
export interface TableContract {
  columns: {
    name: string;
    type: string;
    required: number;
    default: string | null;
    pk: number;
    collation: string;
  }[];
  foreignKeys: string[];
  uniqueKeys: string[];
  checks: string[];
}

/** SQL tokens, not whitespace stripping: preserve string literals and ignore comments. */
export function tokens(sql: string): string[] {
  const pieces =
    sql.match(
      /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-zA-Z_][a-zA-Z_0-9]*|\d+(?:\.\d+)?|<>|!=|<=|>=|\|\||\S/g,
    ) ?? [];
  return pieces
    .filter((p) => !p.startsWith('--') && !p.startsWith('/*'))
    .map((p) => {
      if (p.startsWith("'")) return p;
      if (p.startsWith('"') || p.startsWith('`') || p.startsWith('['))
        return p.slice(1, -1).replaceAll('""', '"').replaceAll('``', '`').toLowerCase();
      return p.toLowerCase();
    });
}

function checks(sql: string): string[] {
  const parts = tokens(sql),
    found: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== 'check' || parts[i + 1] !== '(') continue;
    let depth = 1,
      j = i + 2;
    for (; j < parts.length && depth; j++) {
      if (parts[j] === '(') depth++;
      if (parts[j] === ')') depth--;
    }
    if (depth) throw new Error('Unbalanced CHECK expression');
    found.push(JSON.stringify(parts.slice(i + 2, j - 1)));
    i = j - 1;
  }
  return found.sort();
}

function columnCollations(sql: string): Map<string, string> {
  const parts = tokens(sql),
    output = new Map<string, string>();
  let depth = 0,
    definition: string[] = [];
  const save = () => {
    let nested = 0,
      collation = 'BINARY';
    for (let i = 1; i < definition.length; i++) {
      if (definition[i] === '(') nested++;
      if (definition[i] === ')') nested--;
      if (!nested && definition[i] === 'collate') collation = definition[i + 1]!.toUpperCase();
    }
    if (definition.length) output.set(definition[0]!, collation);
    definition = [];
  };
  for (const part of parts.slice(parts.indexOf('(') + 1)) {
    if ((part === ',' || part === ')') && depth === 0) {
      save();
      if (part === ')') break;
      continue;
    }
    definition.push(part);
    if (part === '(') depth++;
    if (part === ')') depth--;
  }
  return output;
}

/** One metadata-only round trip, no application SELECTs or writes. */
export async function inspectSchema(
  db: SchemaDb,
  tables: readonly string[],
): Promise<Record<string, TableContract>> {
  const result = await db.execute({
    sql: `SELECT s.name, s.sql,
      (SELECT json_group_array(json_object('name',p.name,'type',p.type,'required',p."notnull",'default',p.dflt_value,'pk',p.pk))
        FROM pragma_table_info(s.name) p) AS columns_json,
      (SELECT json_group_array(json_object('id',f.id,'seq',f.seq,'table',f."table",'from',f."from",'to',f."to",'on_update',f.on_update,'on_delete',f.on_delete,'match',f.match))
        FROM pragma_foreign_key_list(s.name) f) AS foreign_json,
      (SELECT json_group_array(json_object('partial',i.partial,'sql',(SELECT sql FROM sqlite_schema WHERE name=i.name),
        'keys',(SELECT json_group_array(json_object('seq',x.seqno,'name',x.name,'coll',x.coll,'desc',x."desc",'cid',x.cid))
                FROM pragma_index_xinfo(i.name) x WHERE x."key"=1)))
        FROM pragma_index_list(s.name) i WHERE i."unique"=1 AND i.origin<>'pk') AS unique_json
      FROM sqlite_schema s WHERE s.type='table' AND s.name IN (SELECT value FROM json_each(?))
      ORDER BY s.name`,
    args: [JSON.stringify(tables)],
  });
  const output: Record<string, TableContract> = {};
  for (const row of result.rows as unknown as Row[]) {
    const collations = columnCollations(String(row.sql));
    const foreign = JSON.parse(String(row.foreign_json)) as Row[];
    const groups = new Map<number, Row[]>();
    for (const fk of foreign) {
      const group = groups.get(Number(fk.id)) ?? [];
      group.push(fk);
      groups.set(Number(fk.id), group);
    }
    output[String(row.name)] = {
      columns: (JSON.parse(String(row.columns_json)) as TableContract['columns'])
        .map((c) => ({
          ...c,
          type: c.type.toUpperCase(),
          default: c.default === null ? null : JSON.stringify(tokens(c.default)),
          collation: collations.get(c.name.toLowerCase()) ?? 'BINARY',
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      foreignKeys: [...groups.values()]
        .map((group) =>
          JSON.stringify(
            group.sort((a, b) => Number(a.seq) - Number(b.seq)).map(({ id, seq, ...key }) => key),
          ),
        )
        .sort(),
      uniqueKeys: (JSON.parse(String(row.unique_json)) as Row[])
        .map((index) => {
          const key = (index.keys as Row[])
            .sort((a, b) => Number(a.seq) - Number(b.seq))
            .map((x) => [x.name, x.coll, x.desc, Number(x.cid) < 0]);
          const predicate = Number(index.partial)
            ? tokens(String(index.sql)).slice(tokens(String(index.sql)).indexOf('where') + 1)
            : [];
          return JSON.stringify({ key, predicate });
        })
        .sort(),
      checks: checks(String(row.sql)),
    };
  }
  return output;
}
