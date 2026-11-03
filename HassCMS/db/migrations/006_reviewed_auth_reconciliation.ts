/** Current audited model only. No request/identity rebuilds or inferred identity values. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Client } from '@libsql/client/web';
import {
  checkSchemaCompatibility,
  type SchemaIssue,
} from '../../src/lib/cms/schema/compatibility.ts';

const AUTH_TABLES = [
  'users',
  'auth_federated_identities',
  'customer_access_requests',
  'auth_oidc_transactions',
  'auth_credentials',
  'auth_sessions',
  'customer_portal_memberships',
  'user_roles',
  'accounts',
  'contacts',
  'audit_events',
] as const;
// Reuse the existing focused, reviewed repair. The full contract is checked
// after creation, in the same transaction, before commit.
const oidcDdl = readFileSync(
  new URL('./003_oidc_transactions_only.sql', import.meta.url),
  'utf8',
).split('-- Read-only verification:')[0]!;

export interface AuthReconciliationResult {
  status: 'READY_TO_ADD_OIDC' | 'ALREADY_COMPATIBLE' | 'APPLIED' | 'BLOCKED';
  issues: SchemaIssue[];
  dataChecks?: {
    foreignKeyViolations: number;
    integrityErrors: number;
    requestIdentityMismatches: number;
  };
}

function checkedCount(value: unknown): number {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isSafeInteger(n) || n < 0)
    throw new Error('Incomplete authentication data verification');
  return n;
}

/** Preview is read-only. Apply rechecks under a write lock and only creates OIDC storage. */
export async function reconcileAuthentication(
  db: Pick<Client, 'transaction'>,
  { apply = false }: { apply?: boolean } = {},
): Promise<AuthReconciliationResult> {
  const tx = await db.transaction(apply ? 'write' : 'read');
  try {
    const objects = (
      await tx.execute(`SELECT name,type FROM sqlite_schema
      WHERE name IN ('auth_oidc_transactions','customer_access_requests_reconciled')`)
    ).rows;
    const oidc = objects.find((r) => r.name === 'auth_oidc_transactions');
    const compatibility = await checkSchemaCompatibility(tx, AUTH_TABLES);
    const issues = compatibility.issues.filter(
      (i) => !(i.table === 'auth_oidc_transactions' && i.requirement === 'table' && !oidc),
    );
    if (oidc && oidc.type !== 'table')
      issues.push({ table: 'auth_oidc_transactions', requirement: 'object-not-table' });
    if (objects.some((r) => r.name === 'customer_access_requests_reconciled'))
      issues.push({
        table: 'customer_access_requests_reconciled',
        requirement: 'unfinished-legacy-rebuild',
      });
    if (issues.length) {
      await tx.rollback();
      return { status: 'BLOCKED', issues };
    }

    // One-off maintenance scans, never called from health or user requests.
    // Only aggregate issue counts leave this function; no customer/provider values.
    let foreignKeyViolations = 0,
      integrityErrors = 0;
    for (const table of ['customer_access_requests', 'auth_federated_identities']) {
      const fk = await tx.execute({
        sql: 'SELECT COUNT(*) AS n FROM pragma_foreign_key_check(?)',
        args: [table],
      });
      foreignKeyViolations += checkedCount(fk.rows[0]?.n);
      const integrity = await tx.execute({
        sql: "SELECT COUNT(*) AS n FROM pragma_integrity_check(?) WHERE integrity_check<>'ok'",
        args: [table],
      });
      integrityErrors += checkedCount(integrity.rows[0]?.n);
    }
    const mismatches = await tx.execute(`SELECT COUNT(*) AS n FROM customer_access_requests r
      JOIN auth_federated_identities f ON f.federated_identity_id=r.federated_identity_id
      WHERE r.identity_method<>'EMAIL_PASSWORD'
        AND (r.user_id<>f.user_id OR r.identity_method<>f.provider)`);
    const dataChecks = {
      foreignKeyViolations,
      integrityErrors,
      requestIdentityMismatches: checkedCount(mismatches.rows[0]?.n),
    };
    if (Object.values(dataChecks).some((n) => n !== 0)) {
      await tx.rollback();
      return {
        status: 'BLOCKED',
        issues: [{ table: 'authentication', requirement: 'existing-data-requires-review' }],
        dataChecks,
      };
    }
    if (apply && !oidc) {
      await tx.execute(oidcDdl);
      const after = await checkSchemaCompatibility(tx, AUTH_TABLES);
      if (!after.ok) {
        await tx.rollback();
        return { status: 'BLOCKED', issues: after.issues, dataChecks };
      }
    }
    await tx.commit();
    return {
      status: oidc ? 'ALREADY_COMPATIBLE' : apply ? 'APPLIED' : 'READY_TO_ADD_OIDC',
      issues: [],
      dataChecks,
    };
  } catch (error) {
    if (!tx.closed) await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let db: Client | undefined;
  try {
    const flags = process.argv.slice(2);
    if (flags.length > 1 || flags.some((s) => s !== '--apply'))
      throw new Error(
        'Usage: node --experimental-strip-types db/migrations/006_reviewed_auth_reconciliation.ts [--apply]',
      );
    const url = process.env.TURSO_CMS_DATABASE_URL,
      authToken = process.env.TURSO_CMS_AUTH_TOKEN;
    if (!url || !authToken)
      throw new Error('Configure TURSO_CMS_DATABASE_URL and TURSO_CMS_AUTH_TOKEN');
    const { createClient } = await import('@libsql/client/web');
    db = createClient({ url, authToken });
    const result = await reconcileAuthentication(db, { apply: flags.includes('--apply') });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === 'BLOCKED') process.exitCode = 1;
  } catch (error) {
    console.error(
      error instanceof Error && /^(Usage:|Configure TURSO)/.test(error.message)
        ? error.message
        : 'Authentication reconciliation was not confirmed. Check access and rerun preview; no legacy data is automatically remapped.',
    );
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
