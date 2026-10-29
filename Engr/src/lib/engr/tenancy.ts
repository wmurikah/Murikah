/**
 * Tenant resolution helpers.
 *
 * Email is unique per organisation, not globally (users has UNIQUE (org_id,
 * email)), so login resolves the tenant by slug first, then looks the user up
 * within that org. After login the org id comes only from the session, never
 * from a request parameter or form field.
 */
import type { Client } from '@libsql/client/web';

export interface Org {
  id: string;
  slug: string;
  name: string;
  status: string; // ACTIVE, SUSPENDED, CANCELLED
}

/**
 * Resolve a live organisation by its unique slug, or null when none matches.
 * Returning null (rather than throwing) lets login answer with a single generic
 * error that does not reveal whether the slug or the email was wrong.
 */
export async function resolveOrgBySlug(db: Client, slug: string): Promise<Org | null> {
  const res = await db.execute({
    sql: `SELECT id, slug, name, status FROM organisations
           WHERE slug = ? AND deleted_at IS NULL LIMIT 1`,
    args: [slug],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    status: String(row.status),
  };
}
