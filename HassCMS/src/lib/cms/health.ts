import type { SchemaDb } from './schema/inspect.ts';
import { checkSchemaCompatibility, READINESS_TABLES } from './schema/compatibility.ts';

export type HealthState = 'ok' | 'degraded' | 'down';
export interface HealthCheck {
  name: string;
  state: HealthState;
  detail: string;
}

/** Schema readiness and reachability only; permissions/grants are separate checks. */
export async function checkCmsHealth(db: SchemaDb, traceId: string) {
  const checks: HealthCheck[] = [{ name: 'Application', state: 'ok', detail: 'Running.' }];
  try {
    await db.execute('SELECT 1');
  } catch {
    checks.push({ name: 'Database', state: 'down', detail: 'Not reachable.' });
    return { status: 'down' as HealthState, checks };
  }
  checks.push({ name: 'Database', state: 'ok', detail: 'Reachable.' });
  let status: HealthState = 'ok';
  try {
    const result = await checkSchemaCompatibility(db, READINESS_TABLES);
    if (!result.ok) {
      status = 'degraded';
      console.error(`[cms.health] ${traceId} schema incompatibility`, result.issues);
    }
    checks.push({
      name: 'Schema compatibility',
      state: result.ok ? 'ok' : 'degraded',
      detail: result.ok ? 'Compatible.' : 'Required schema is incompatible.',
    });
  } catch {
    status = 'degraded';
    console.error(`[cms.health] ${traceId} schema metadata check failed`);
    checks.push({
      name: 'Schema compatibility',
      state: 'degraded',
      detail: 'Could not be checked.',
    });
  }
  // Preserve prerequisites outside the audited table contract. Metadata only.
  const prerequisites = [
    [
      'Source completeness columns',
      "SELECT COUNT(*) AS n FROM pragma_table_info('purchase_order_lines') WHERE name='unit_cost'",
      1,
    ],
    [
      'Portal visibility',
      "SELECT COUNT(*) AS n FROM pragma_table_info('entity_attachments') WHERE name='customer_visible'",
      1,
    ],
    [
      'Audit immutability triggers',
      "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='trigger' AND name IN ('trg_audit_events_no_update','trg_audit_events_no_delete')",
      2,
    ],
    [
      'Assistant and channel tables',
      "SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('ai_providers','bot_conversations','bot_messages','channel_connections','channel_messages','message_classifications')",
      6,
    ],
  ] as const;
  for (const [name, sql, expected] of prerequisites) {
    try {
      const result = await db.execute(sql);
      const ok = Number(result.rows[0]?.n ?? 0) === expected;
      if (!ok) status = 'degraded';
      checks.push({
        name,
        state: ok ? 'ok' : 'degraded',
        detail: ok ? 'Applied.' : 'Required prerequisite is missing.',
      });
    } catch {
      status = 'degraded';
      checks.push({ name, state: 'degraded', detail: 'Could not be checked.' });
    }
  }
  return { status, checks };
}

export const healthHttpStatus = (status: HealthState): number => (status === 'ok' ? 200 : 503);
