/**
 * A finding's responsibles (work_paper_responsibles, each with a role_in_finding
 * such as PRIMARY) and its CC recipients (work_paper_cc_recipients). Both are
 * scoped to the acting organisation and managed from the work-paper form.
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
    sql: `SELECT r.responsible_id AS id, r.user_id AS user_id, r.role_in_finding AS role_in_finding,
                 u.full_name AS name
            FROM work_paper_responsibles r
            LEFT JOIN users u ON u.user_id = r.user_id
           WHERE r.organization_id = ? AND r.work_paper_id = ?
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
  await db.execute({
    sql: `INSERT INTO work_paper_responsibles
            (responsible_id, organization_id, work_paper_id, user_id, role_in_finding, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      organizationId,
      workPaperId,
      userId,
      roleInFinding,
      new Date().toISOString(),
    ],
  });
}

export async function removeResponsible(
  db: Client,
  organizationId: string,
  responsibleId: string,
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM work_paper_responsibles WHERE responsible_id = ? AND organization_id = ?`,
    args: [responsibleId, organizationId],
  });
}

export async function listCcRecipients(
  db: Client,
  organizationId: string,
  workPaperId: string,
): Promise<CcRecipient[]> {
  const res = await db.execute({
    sql: `SELECT c.cc_id AS id, c.user_id AS user_id, u.full_name AS name
            FROM work_paper_cc_recipients c
            LEFT JOIN users u ON u.user_id = c.user_id
           WHERE c.organization_id = ? AND c.work_paper_id = ?
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
  await db.execute({
    sql: `INSERT INTO work_paper_cc_recipients
            (cc_id, organization_id, work_paper_id, user_id, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [crypto.randomUUID(), organizationId, workPaperId, userId, new Date().toISOString()],
  });
}

export async function removeCcRecipient(
  db: Client,
  organizationId: string,
  ccId: string,
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM work_paper_cc_recipients WHERE cc_id = ? AND organization_id = ?`,
    args: [ccId, organizationId],
  });
}
