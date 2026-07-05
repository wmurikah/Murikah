/**
 * The evidence access boundary, enforced server-side on every upload and
 * download. An auditor (holding the entity's view or edit permission) or a
 * platform owner may act on any evidence in their organisation. An auditee may
 * only reach evidence on their own findings and plans: a work paper they are a
 * responsible or CC on, or an action plan they own or raised. Every check is
 * scoped by the acting organization_id.
 */
import type { Client } from '@libsql/client/web';

export interface EvidenceActor {
  userId: string;
  organizationId: string;
  isPlatformOwner: boolean;
  perms: string[];
}

/** Whether the user is personally linked to the entity (the auditee-safe path). */
async function isLinkedToEntity(
  db: Client,
  organizationId: string,
  userId: string,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  if (entityType === 'work_paper') {
    const res = await db.execute({
      sql: `SELECT 1 FROM work_paper_responsibles
             WHERE organization_id = ? AND work_paper_id = ? AND user_id = ?
             UNION ALL
            SELECT 1 FROM work_paper_cc_recipients
             WHERE organization_id = ? AND work_paper_id = ? AND user_id = ?
             LIMIT 1`,
      args: [organizationId, entityId, userId, organizationId, entityId, userId],
    });
    return res.rows.length > 0;
  }
  if (entityType === 'action_plan') {
    const res = await db.execute({
      sql: `SELECT 1 FROM action_plan_owners
             WHERE organization_id = ? AND action_plan_id = ? AND user_id = ? AND is_active = 1
             UNION ALL
            SELECT 1 FROM action_plans
             WHERE organization_id = ? AND action_plan_id = ? AND created_by = ?
             LIMIT 1`,
      args: [organizationId, entityId, userId, organizationId, entityId, userId],
    });
    return res.rows.length > 0;
  }
  return false;
}

function viewPermission(entityType: string): string {
  return entityType === 'action_plan' ? 'ACTION_PLANS.view' : 'WORK_PAPERS.view';
}

function editPermission(entityType: string): string {
  return entityType === 'action_plan' ? 'ACTION_PLANS.edit' : 'WORK_PAPERS.edit';
}

/** Whether the actor may see (and download) evidence on the entity. */
export async function canViewEvidence(
  db: Client,
  actor: EvidenceActor,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  if (actor.isPlatformOwner) return true;
  if (actor.perms.includes(viewPermission(entityType))) return true;
  return isLinkedToEntity(db, actor.organizationId, actor.userId, entityType, entityId);
}

/** Whether the actor may upload evidence to the entity. */
export async function canUploadEvidence(
  db: Client,
  actor: EvidenceActor,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  if (actor.isPlatformOwner) return true;
  if (actor.perms.includes(editPermission(entityType))) return true;
  return isLinkedToEntity(db, actor.organizationId, actor.userId, entityType, entityId);
}
