/**
 * Work-paper requirements: the evidence and test items on a finding
 * (work_paper_requirements). Add, edit, mark status and remove, all scoped to
 * the acting organisation and gated by the caller on REQUIREMENTS.manage.
 */
import type { Client } from '@libsql/client/web';

export interface Requirement {
  id: string;
  workPaperId: string;
  description: string;
  status: string;
  createdAt: string | null;
}

export async function listRequirements(
  db: Client,
  organizationId: string,
  workPaperId: string,
): Promise<Requirement[]> {
  const res = await db.execute({
    sql: `SELECT requirement_id AS id, work_paper_id, description, status, created_at
            FROM work_paper_requirements
           WHERE organization_id = ? AND work_paper_id = ?
        ORDER BY created_at`,
    args: [organizationId, workPaperId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    workPaperId: String(r.work_paper_id),
    description: String(r.description ?? ''),
    status: String(r.status ?? ''),
    createdAt: r.created_at == null ? null : String(r.created_at),
  }));
}

export async function addRequirement(
  db: Client,
  organizationId: string,
  workPaperId: string,
  description: string,
  status: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO work_paper_requirements
            (requirement_id, organization_id, work_paper_id, description, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, organizationId, workPaperId, description, status, now, now],
  });
  return id;
}

export async function updateRequirement(
  db: Client,
  organizationId: string,
  requirementId: string,
  description: string,
  status: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE work_paper_requirements
              SET description = ?, status = ?, updated_at = ?
            WHERE requirement_id = ? AND organization_id = ?`,
    args: [description, status, new Date().toISOString(), requirementId, organizationId],
  });
}

export async function removeRequirement(
  db: Client,
  organizationId: string,
  requirementId: string,
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM work_paper_requirements WHERE requirement_id = ? AND organization_id = ?`,
    args: [requirementId, organizationId],
  });
}
