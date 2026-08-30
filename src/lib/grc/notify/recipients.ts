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

/**
 * The Head of Audit recipients: the organisation's own active SUPER_ADMIN users,
 * except the triggering user, and never the platform owner (Build Prompt 60).
 *
 * The platform owner is a Murikah Labs role, not a member of the customer's
 * audit function. Their account carries SUPER_ADMIN and sits in an organisation
 * (they have to be somewhere), so a role-only lookup resolved them as that
 * organisation's head of audit and posted them every operational reminder and
 * copy the instance generated: mail addressed to a person who does not run the
 * audit, about findings that are not theirs, in a tenant they are only
 * administering. `is_platform_owner` is the line between running the platform
 * and running an audit, so it is the line drawn here.
 *
 * This is a recipient rule, not a permission one: an owner who enters an
 * instance still sees everything the screens show them. They are simply not
 * mailed as though the audit were theirs.
 */
export async function listHoaRecipients(
  db: Client,
  organizationId: string,
  exceptUserId: string | null,
): Promise<Recipient[]> {
  const res = await db.execute({
    sql: `SELECT user_id, email, full_name FROM users
           WHERE organization_id = ? AND role_code = 'SUPER_ADMIN' AND email IS NOT NULL
             AND COALESCE(is_platform_owner, 0) = 0 AND ${ACTIVE}`,
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

/**
 * Everybody named on the auditee side of a finding: its responsibles, its CC
 * recipients, and anybody it has been delegated to (Build Prompt 68).
 *
 * The auditee loop's failure mode is somebody assuming somebody else was told,
 * so every move in it goes to this whole set rather than to the person who
 * happens to act next. A CC recipient is on the list precisely because being
 * copied is what they asked for: they take no action, and they are entitled to
 * know the finding was delegated, drafted, returned and released without having
 * to ask.
 *
 * Delegates are included by history rather than by live status. A supervisor
 * who drafted round one and handed it back should still be told what audit made
 * of the thing they wrote; dropping them the moment they return it is how the
 * person who did the work is the only one who never hears the outcome.
 *
 * The junction tables carry no organisation of their own, so all three are
 * scoped through the finding.
 */
export async function workPaperAuditeeIds(
  db: Client,
  organizationId: string,
  workPaperId: string,
): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT r.user_id AS user_id FROM work_paper_responsibles r
            JOIN work_papers wp ON wp.work_paper_id = r.work_paper_id AND wp.organization_id = ?
           WHERE r.work_paper_id = ?
           UNION
          SELECT c.user_id AS user_id FROM work_paper_cc_recipients c
            JOIN work_papers wp ON wp.work_paper_id = c.work_paper_id AND wp.organization_id = ?
           WHERE c.work_paper_id = ? AND c.user_id IS NOT NULL
           UNION
          SELECT d.delegated_to AS user_id FROM auditee_delegations d
           WHERE d.organization_id = ? AND d.work_paper_id = ?`,
    args: [organizationId, workPaperId, organizationId, workPaperId, organizationId, workPaperId],
  });
  const ids = new Set<string>();
  for (const r of res.rows) {
    const id = r.user_id == null ? '' : String(r.user_id).trim();
    if (id !== '') ids.add(id);
  }
  return [...ids];
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
