/**
 * Action-plan owners. The denormalised `owner_ids`/`owner_names` on
 * `action_plans` are kept in sync with the `action_plan_owners` junction, which
 * records original and current owners and their add/remove history. Every
 * assignment and delegation goes through setOwners, so the two never drift. All
 * writes are scoped to the acting organisation.
 *
 * `owner_ids` is stored as a comma-delimited list of user ids and `owner_names`
 * as a comma-delimited list of names, matching the source's denormalisation.
 */
import type { Client, InStatement } from '@libsql/client/web';

/** Parse the denormalised owner id list into an array. */
export function parseOwnerIds(ownerIds: string | null | undefined): string[] {
  if (!ownerIds) return [];
  return ownerIds
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Whether a user is among a plan's owners, from the denormalised list. */
export function isOwner(ownerIds: string | null | undefined, userId: string): boolean {
  return parseOwnerIds(ownerIds).includes(userId);
}

export interface OwnerRef {
  userId: string;
  name: string;
}

/**
 * Replace a plan's current owners with the given set, in one atomic batch: the
 * denormalised fields are rewritten, every prior current owner is marked
 * removed, and the new owners are inserted as current (preserving whether they
 * were original). `markOriginal` seeds the original owners on creation.
 */
export async function setOwners(
  db: Client,
  organizationId: string,
  actionPlanId: string,
  owners: OwnerRef[],
  markOriginal = false,
): Promise<void> {
  const now = new Date().toISOString();
  const ownerIds = owners.map((o) => o.userId).join(',');
  const ownerNames = owners.map((o) => o.name).join(', ');

  const statements: InStatement[] = [
    {
      sql: `UPDATE action_plans SET owner_ids = ?, owner_names = ?, updated_at = ?
             WHERE action_plan_id = ? AND organization_id = ?`,
      args: [ownerIds, ownerNames, now, actionPlanId, organizationId],
    },
    // Retire the current owners; the junction keeps the history. action_plan_owners
    // has no organization_id of its own, so tenancy is enforced through its plan.
    {
      sql: `UPDATE action_plan_owners SET is_current = 0, removed_at = ?
             WHERE action_plan_id = ? AND is_current = 1
               AND EXISTS (SELECT 1 FROM action_plans WHERE action_plan_id = ? AND organization_id = ?)`,
      args: [now, actionPlanId, actionPlanId, organizationId],
    },
  ];
  for (const o of owners) {
    // Keyed by (action_plan_id, user_id); OR REPLACE refreshes an owner who stays
    // on and records the original-owner flag on creation.
    statements.push({
      sql: `INSERT OR REPLACE INTO action_plan_owners
              (action_plan_id, user_id, is_original, is_current, added_at)
            VALUES (?, ?, ?, 1, ?)`,
      args: [actionPlanId, o.userId, markOriginal ? 1 : 0, now],
    });
  }
  await db.batch(statements, 'write');
}

/**
 * Resolve a set of user ids to owner references (id and name) within the acting
 * organisation, preserving the given order. Used when a form submits owner ids
 * and the executor needs names for the denormalised `owner_names`. Ids that do
 * not belong to the organisation are dropped, so owners never cross tenants.
 */
export async function resolveOwners(
  db: Client,
  organizationId: string,
  userIds: string[],
): Promise<OwnerRef[]> {
  const ids = userIds.map((u) => u.trim()).filter(Boolean);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const res = await db.execute({
    sql: `SELECT user_id, full_name FROM users
           WHERE organization_id = ? AND user_id IN (${placeholders})`,
    args: [organizationId, ...ids],
  });
  const nameById = new Map(
    res.rows.map((r) => [String(r.user_id), String(r.full_name ?? r.user_id)]),
  );
  return ids
    .filter((uid) => nameById.has(uid))
    .map((uid) => ({ userId: uid, name: nameById.get(uid) ?? uid }));
}

/** The junction history for a plan, for the detail's owner history. */
export interface OwnerHistoryRow {
  userId: string;
  name: string | null;
  ownerType: string;
  isActive: boolean;
  addedAt: string | null;
  removedAt: string | null;
}

export async function listOwnerHistory(
  db: Client,
  organizationId: string,
  actionPlanId: string,
): Promise<OwnerHistoryRow[]> {
  const res = await db.execute({
    sql: `SELECT o.user_id, o.is_original, o.is_current, o.added_at, o.removed_at, u.full_name AS name
            FROM action_plan_owners o
            JOIN action_plans ap ON ap.action_plan_id = o.action_plan_id AND ap.organization_id = ?
            LEFT JOIN users u ON u.user_id = o.user_id
           WHERE o.action_plan_id = ?
        ORDER BY o.added_at`,
    args: [organizationId, actionPlanId],
  });
  return res.rows.map((r) => ({
    userId: String(r.user_id),
    name: r.name == null ? null : String(r.name),
    ownerType: Number(r.is_original ?? 0) === 1 ? 'ORIGINAL' : 'CURRENT',
    isActive: Number(r.is_current ?? 0) === 1,
    addedAt: r.added_at == null ? null : String(r.added_at),
    removedAt: r.removed_at == null ? null : String(r.removed_at),
  }));
}
