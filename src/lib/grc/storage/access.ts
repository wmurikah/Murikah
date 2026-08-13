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
    // Three ways to be personally linked to a finding, and a delegate is the
    // third (Build Prompt 68). A depot supervisor asked to draft the response
    // holds no audit permission and is on neither named list; the live
    // delegation is their whole standing, and attaching what supports the draft
    // is most of what they were asked to do. A returned delegation does not
    // count: they handed the work back, and history is not access.
    const res = await db.execute({
      // None of the three junctions carries organization_id; scope through the
      // work paper, except the delegation, which carries its own.
      sql: `SELECT 1 FROM work_paper_responsibles r
              JOIN work_papers wp ON wp.work_paper_id = r.work_paper_id AND wp.organization_id = ?
             WHERE r.work_paper_id = ? AND r.user_id = ?
             UNION ALL
            SELECT 1 FROM work_paper_cc_recipients c
              JOIN work_papers wp ON wp.work_paper_id = c.work_paper_id AND wp.organization_id = ?
             WHERE c.work_paper_id = ? AND c.user_id = ?
             UNION ALL
            SELECT 1 FROM auditee_delegations d
             WHERE d.organization_id = ? AND d.work_paper_id = ? AND d.delegated_to = ?
               AND d.status = 'ISSUED'
             LIMIT 1`,
      args: [
        organizationId,
        entityId,
        userId,
        organizationId,
        entityId,
        userId,
        organizationId,
        entityId,
        userId,
      ],
    });
    return res.rows.length > 0;
  }
  if (entityType === 'requirement') {
    // The owners named on the requirement, scoped through the requirement to
    // the organisation (the junction carries no organization_id of its own).
    // This is the whole of an auditee owner's access: they hold no audit
    // permission at all, and the row naming them is what lets them upload the
    // document they were asked for and read it back afterwards.
    const res = await db.execute({
      sql: `SELECT 1 FROM requirement_owners o
              JOIN work_paper_requirements r ON r.requirement_id = o.requirement_id
                AND r.organization_id = ?
             WHERE o.requirement_id = ? AND o.user_id = ? LIMIT 1`,
      args: [organizationId, entityId, userId],
    });
    return res.rows.length > 0;
  }
  if (entityType === 'action_plan') {
    const res = await db.execute({
      // action_plan_owners has no organization_id; scope through the plan and use
      // is_current (there is no is_active column).
      sql: `SELECT 1 FROM action_plan_owners o
              JOIN action_plans ap ON ap.action_plan_id = o.action_plan_id AND ap.organization_id = ?
             WHERE o.action_plan_id = ? AND o.user_id = ? AND o.is_current = 1
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
  return entityType.startsWith('action_plan') ? 'ACTION_PLANS.view' : 'WORK_PAPERS.view';
}

/**
 * The permission that lets an auditor put evidence on an entity. A requirement's
 * evidence is the answer to it, and the people who provide answers are its
 * owners, so the audit-side permission here is the one that manages requirements
 * rather than the one that edits findings.
 */
function editPermission(entityType: string): string {
  if (entityType.startsWith('action_plan')) return 'ACTION_PLANS.edit';
  if (entityType === 'requirement') return 'REQUIREMENTS.manage';
  return 'WORK_PAPERS.edit';
}

/**
 * A draft entity stages evidence for a record that does not exist yet: the
 * create form uploads against a random draft token, and saving the record
 * rebinds the staged attachments to the real id (repos/evidence.ts). Staging
 * is gated on the matching create permission (an auditee proposing a plan
 * stages under their respond permission).
 */
export function isDraftEntity(entityType: string): boolean {
  return entityType === 'work_paper_draft' || entityType === 'action_plan_draft';
}

function canStage(actor: EvidenceActor, entityType: string): boolean {
  if (actor.isPlatformOwner) return true;
  if (entityType === 'action_plan_draft') {
    return actor.perms.includes('ACTION_PLANS.create') || actor.perms.includes('AUDITEE.respond');
  }
  return actor.perms.includes('WORK_PAPERS.create');
}

/** Whether the actor may see (and download) evidence on the entity. */
export async function canViewEvidence(
  db: Client,
  actor: EvidenceActor,
  entityType: string,
  entityId: string,
): Promise<boolean> {
  if (actor.isPlatformOwner) return true;
  if (isDraftEntity(entityType)) return canStage(actor, entityType);
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
  if (isDraftEntity(entityType)) return canStage(actor, entityType);
  if (actor.perms.includes(editPermission(entityType))) return true;
  return isLinkedToEntity(db, actor.organizationId, actor.userId, entityType, entityId);
}
