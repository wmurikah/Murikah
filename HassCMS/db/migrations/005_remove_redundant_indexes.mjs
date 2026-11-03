import { pathToFileURL } from 'node:url';

// Deliberate allowlist: overlapping prefixes alone never qualify for removal.
export const candidates = [
  ['business_units', 'idx_business_units_code', ['business_unit_code']],
  ['users', 'idx_users_email', ['email'], 'NOCASE'],
  ['accounts', 'idx_accounts_oracle_code', ['oracle_customer_code']],
  ['record_snapshots', 'idx_snapshots_entity', ['entity_type', 'entity_id', 'version_no']],
  ['sla_escalation_events', 'ix_sla_escalation_instance', ['sla_instance_id', 'escalation_level']],
  ['so_extract_rows', 'ix_so_extract_batch', ['import_batch_id', 'source_row_number']],
  ['po_extract_rows', 'ix_po_extract_batch', ['import_batch_id', 'source_row_number']],
  ['bot_messages', 'ix_bot_msg_conv', ['bot_conversation_id', 'sequence_no']],
];

const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
async function keys(db, name) {
  const result = await db.execute({
    sql: 'SELECT seqno,cid,name,coll,"desc" FROM pragma_index_xinfo(?) WHERE "key"=1 ORDER BY seqno',
    args: [name],
  });
  return result.rows.map((r) => [Number(r.cid), String(r.name), String(r.coll), Number(r.desc)]);
}

/** Inspect and (optionally) remove all eight indexes atomically via libSQL. */
export async function removeRedundantIndexes(client, { apply = false } = {}) {
  const tx = await client.transaction(apply ? 'write' : 'read');
  try {
    const results = [];
    const schema = (await tx.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema')).rows;
    // Stored SQL can force an index too. Never silently invalidate such objects.
    for (const [, name] of candidates) {
      const reference = schema.find(
        (s) =>
          ['view', 'trigger'].includes(s.type) &&
          /\bINDEXED\s+BY\b/i.test(String(s.sql)) &&
          String(s.sql).toLowerCase().includes(name.toLowerCase()),
      );
      if (reference)
        throw new Error(`Index ${name} may be named by ${reference.type} ${reference.name}`);
    }
    for (const [table, name, columns, collation = 'BINARY'] of candidates) {
      const indexes = (
        await tx.execute({ sql: 'SELECT * FROM pragma_index_list(?)', args: [table] })
      ).rows;
      const expectedKeys = (k) =>
        k.length === columns.length &&
        k.every(
          ([cid, col, coll, desc], i) =>
            cid >= 0 && col === columns[i] && coll === collation && desc === 0,
        );
      let replacement;
      for (const index of indexes) {
        if (
          Number(index.unique) === 1 &&
          index.origin === 'u' &&
          Number(index.partial) === 0 &&
          expectedKeys(await keys(tx, index.name))
        ) {
          replacement = String(index.name);
          break;
        }
      }
      if (!replacement) throw new Error(`No matching UNIQUE constraint index for ${table}/${name}`);
      const existing = schema.find((s) => s.name === name);
      if (existing) {
        const index = indexes.find((i) => i.name === name);
        if (
          existing.type !== 'index' ||
          existing.tbl_name !== table ||
          !index ||
          index.origin !== 'c' ||
          Number(index.unique) !== 0 ||
          Number(index.partial) !== 0 ||
          !expectedKeys(await keys(tx, name))
        ) {
          throw new Error(`Unexpected definition for ${name}; nothing removed`);
        }
      }
      results.push({
        table,
        index: name,
        replacement,
        status: existing ? (apply ? 'REMOVED' : 'WOULD_REMOVE') : 'ALREADY_ABSENT',
      });
    }
    // Every candidate is checked before the first mutation. A later failure
    // also rolls back all prior drops, rather than leaving a partial cleanup.
    if (apply) {
      for (const result of results) {
        if (result.status === 'REMOVED') await tx.execute(`DROP INDEX ${quote(result.index)}`);
      }
    }
    await tx.commit();
    return results;
  } catch (error) {
    await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let client;
  try {
    const flags = process.argv.slice(2);
    if (flags.some((flag) => flag !== '--apply') || flags.length > 1)
      throw new Error('Usage: node db/migrations/005_remove_redundant_indexes.mjs [--apply]');
    const url = process.env.TURSO_CMS_DATABASE_URL;
    const authToken = process.env.TURSO_CMS_AUTH_TOKEN;
    if (!url || !authToken)
      throw new Error(
        'Set TURSO_CMS_DATABASE_URL and TURSO_CMS_AUTH_TOKEN in the execution environment',
      );
    const { createClient } = await import('@libsql/client/web');
    client = createClient({ url, authToken });
    console.log(
      JSON.stringify(
        await removeRedundantIndexes(client, { apply: flags.includes('--apply') }),
        null,
        2,
      ),
    );
  } catch (error) {
    // Do not echo client configuration or transport errors that could contain credentials.
    console.error(
      error instanceof Error &&
        /^(No matching|Unexpected definition|Index |Usage:|Set TURSO)/.test(error.message)
        ? error.message
        : 'Index cleanup failed; transaction was not confirmed. Check connectivity/permissions and rerun the preview.',
    );
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}
