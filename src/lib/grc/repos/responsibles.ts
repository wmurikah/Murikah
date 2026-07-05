/**
 * A finding's responsibles (work_paper_responsibles, each with a role_in_finding
 * such as PRIMARY) and its CC recipients (work_paper_cc_recipients). Neither
 * junction carries its own organization_id or a surrogate key (Build Prompt 16):
 * each is keyed by (work_paper_id, user_id) with an added_at stamp, so a row is
 * identified by the user within the work paper. Tenancy is still enforced on
 * every read and write by joining to (or requiring) a work_papers row in the
 * acting organisation, so a work paper from another organisation is never
 * touched.
 */
import type { Client } from '@libsql/client/web';

export interface Responsible {
  id: string;
  userId: string;
  name: string | null;
  roleInFinding: string;
}

export interface CcRecipient {
  id: string;
  userId: string;
  name: string | null;
}

export async function listResponsibles(
  db: Client,
  organizationId: string,
  workPaperId: string,
): Promise<Responsible[]> {
  const res = await db.execute({
    sql: `SELECT r.user_id AS id, r.user_id AS user_id, r.role_in_finding AS role_in_finding,
                 u.full_name AS name
            FROM work_paper_responsibles r
            JOIN work_papers wp ON wp.work_paper_id = r.work_paper_id AND wp.organization_id = ?
            LEFT JOIN users u ON u.user_id = r.user_id
           WHERE r.work_paper_id = ?
        ORDER BY r.role_in_finding, u.full_name`,
    args: [organizationId, workPaperId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    userId: String(r.user_id),
    name: r.name == null ? null : String(r.name),
    roleInFinding: String(r.role_in_finding ?? ''),
  }));
}

export async function addResponsible(
  db: Client,
  organizationId: string,
  workPaperId: string,
  userId: string,
  roleInFinding: string,
): Promise<void> {
  // Keyed by (work_paper_id, user_id): OR REPLACE keeps re-adding idempotent and
  // lets the role change. The insert lands only when the work paper is in the
  // acting organisation.
  await db.execute({
    sql: `INSERT OR REPLACE INTO work_paper_responsibles
            (work_paper_id, user_id, role_in_finding, added_at)
          SELECT ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM work_papers WHERE work_paper_id = ? AND organization_id = ?)`,
    args: [
      workPaperId,
      userId,
      roleInFinding,
      new Date().toISOString(),
      workPaperId,
      organizationId,
    ],
  });
}

export async function removeResponsible(
  db: Client,
  organizationId: string,
  workPaperId: string,
  userId: string,
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM work_paper_responsibles
           WHERE work_paper_id = ? AND user_id = ?
             AND EXISTS (SELECT 1 FROM work_papers WHERE work_paper_id = ? AND organization_id = ?)`,
    args: [workPaperId, userId, workPaperId, organizationId],
  });
}

export async function listCcRecipients(
  db: Client,
  organizationId: string,
  workPaperId: string,
): Promise<CcRecipient[]> {
  const res = await db.execute({
    sql: `SELECT c.user_id AS id, c.user_id AS user_id, u.full_name AS name
            FROM work_paper_cc_recipients c
            JOIN work_papers wp ON wp.work_paper_id = c.work_paper_id AND wp.organization_id = ?
            LEFT JOIN users u ON u.user_id = c.user_id
           WHERE c.work_paper_id = ?
        ORDER BY u.full_name`,
    args: [organizationId, workPaperId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    userId: String(r.user_id),
    name: r.name == null ? null : String(r.name),
  }));
}

export async function addCcRecipient(
  db: Client,
  organizationId: string,
  workPaperId: string,
  userId: string,
): Promise<void> {
  // work_paper_cc_recipients carries the recipient email alongside the user id;
  // it is taken from the user row so the column is always populated, and only
  // when the work paper is in the acting organisation.
  await db.execute({
    sql: `INSERT OR REPLACE INTO work_paper_cc_recipients (work_paper_id, user_id, email, added_at)
          SELECT ?, u.user_id, u.email, ?
            FROM users u
           WHERE u.user_id = ?
             AND EXISTS (SELECT 1 FROM work_papers WHERE work_paper_id = ? AND organization_id = ?)`,
    args: [workPaperId, new Date().toISOString(), userId, workPaperId, organizationId],
  });
}

export async function removeCcRecipient(
  db: Client,
  organizationId: string,
  workPaperId: string,
  userId: string,
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM work_paper_cc_recipients
           WHERE work_paper_id = ? AND user_id = ?
             AND EXISTS (SELECT 1 FROM work_papers WHERE work_paper_id = ? AND organization_id = ?)`,
    args: [workPaperId, userId, workPaperId, organizationId],
  });
}
