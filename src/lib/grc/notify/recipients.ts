/**
 * Recipient resolution for the notification queue. Every lookup is scoped by the
 * acting organization_id and skips inactive users, so a notification never goes
 * to a disabled account or crosses tenants. The per-entity helpers resolve the
 * interested parties for the shared enqueue path: an action plan's owners, and a
 * work paper's assigned auditor and responsibles. Column names follow
 * grc/docs/schema-assumptions.md.
 */
import type { Client } from '@libsql/client/web';

export interface Recipient {
  userId: string;
  email: string;
  name: string;
}

const ACTIVE =
  "UPPER(COALESCE(status, '')) NOT IN ('INACTIVE', 'DISABLED', 'SUSPENDED', 'ARCHIVED', 'DELETED')";

/** Resolve user ids to active recipients with an email, preserving no order guarantee. */
export async function resolveActiveRecipients(
  db: Client,
  organizationId: string,
  userIds: string[],
): Promise<Recipient[]> {
  const ids = [...new Set(userIds.map((u) => u.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const ph = ids.map(() => '?').join(', ');
  const res = await db.execute({
    sql: `SELECT user_id, email, full_name FROM users
           WHERE organization_id = ? AND user_id IN (${ph}) AND email IS NOT NULL AND ${ACTIVE}`,
    args: [organizationId, ...ids],
  });
  return res.rows.map((r) => ({
    userId: String(r.user_id),
    email: String(r.email),
    name: String(r.full_name ?? r.email),
  }));
}

export async function resolveActiveRecipient(
  db: Client,
  organizationId: string,
  userId: string,
): Promise<Recipient | null> {
  const [r] = await resolveActiveRecipients(db, organizationId, [userId]);
  return r ?? null;
}

/** The Head of Audit recipients: active SUPER_ADMIN users, except the triggering user. */
export async function listHoaRecipients(
  db: Client,
  organizationId: string,
  exceptUserId: string | null,
): Promise<Recipient[]> {
  const res = await db.execute({
    sql: `SELECT user_id, email, full_name FROM users
           WHERE organization_id = ? AND role_code = 'SUPER_ADMIN' AND email IS NOT NULL AND ${ACTIVE}`,
    args: [organizationId],
  });
  return res.rows
    .map((r) => ({
      userId: String(r.user_id),
      email: String(r.email),
      name: String(r.full_name ?? r.email),
    }))
    .filter((r) => r.userId !== exceptUserId);
}

/** The owner user ids of an action plan (from the denormalised owner_ids). */
export async function actionPlanOwnerIds(
  db: Client,
  organizationId: string,
  actionPlanId: string,
): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT owner_ids FROM action_plans WHERE action_plan_id = ? AND organization_id = ? LIMIT 1`,
    args: [actionPlanId, organizationId],
  });
  const raw = res.rows[0]?.owner_ids;
  return raw == null
    ? []
    : String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/** A work paper's interested parties: the assigned auditor and its responsibles. */
export async function workPaperPartyIds(
  db: Client,
  organizationId: string,
  workPaperId: string,
): Promise<string[]> {
  const [wp, resp] = await Promise.all([
    db.execute({
      sql: `SELECT assigned_auditor_id AS assigned_auditor FROM work_papers
             WHERE work_paper_id = ? AND organization_id = ? LIMIT 1`,
      args: [workPaperId, organizationId],
    }),
    db.execute({
      // work_paper_responsibles has no organization_id; scope through the paper.
      sql: `SELECT r.user_id FROM work_paper_responsibles r
              JOIN work_papers wp ON wp.work_paper_id = r.work_paper_id AND wp.organization_id = ?
             WHERE r.work_paper_id = ?`,
      args: [organizationId, workPaperId],
    }),
  ]);
  const ids = new Set<string>();
  const auditor = wp.rows[0]?.assigned_auditor;
  if (auditor != null && String(auditor) !== '') ids.add(String(auditor));
  for (const r of resp.rows) ids.add(String(r.user_id));
  return [...ids];
}
