import contract from './contract.json' with { type: 'json' };
import { inspectSchema, type SchemaDb, type TableContract } from './inspect.ts';

export const schemaContract = contract as Record<string, TableContract>;
/** Bounded readiness coverage for the audited authentication, inbox, portal and SLA paths. */
export const READINESS_TABLES = [
  'users',
  'auth_oidc_transactions',
  'auth_federated_identities',
  'customer_access_requests',
  'contacts',
  'survey_invitations',
  'customer_portal_memberships',
  'sla_instances',
  'sla_timer_events',
  'sla_breaches',
  'sla_escalation_events',
  'notifications',
  'so_extract_rows',
  'po_extract_rows',
] as const;
export const SLA_TABLES = [
  'sla_instances',
  'sla_timer_events',
  'sla_breaches',
  'sla_escalation_events',
] as const;

export interface SchemaIssue {
  table: string;
  requirement: string;
}
export async function checkSchemaCompatibility(
  db: SchemaDb,
  tables: readonly string[] = Object.keys(schemaContract),
) {
  const actual = await inspectSchema(db, tables);
  const issues: SchemaIssue[] = [];
  for (const table of tables) {
    const expected = schemaContract[table],
      found = actual[table];
    if (!expected) throw new Error('Unknown schema contract table');
    if (!found) {
      issues.push({ table, requirement: 'table' });
      continue;
    }
    for (const column of expected.columns) {
      const observed = found.columns.find((c) => c.name === column.name);
      if (!observed || JSON.stringify(observed) !== JSON.stringify(column))
        issues.push({ table, requirement: `column:${column.name}` });
    }
    for (const column of found.columns) {
      if (
        !expected.columns.some((c) => c.name === column.name) &&
        (column.pk || (column.required && column.default === null))
      )
        issues.push({ table, requirement: `unexpected-required-column:${column.name}` });
    }
    for (const key of ['foreignKeys', 'uniqueKeys', 'checks'] as const) {
      if (JSON.stringify(found[key]) !== JSON.stringify(expected[key]))
        issues.push({ table, requirement: key });
    }
  }
  return { ok: issues.length === 0, issues };
}
