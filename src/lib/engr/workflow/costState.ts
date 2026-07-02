/**
 * Costing ladder: the only writer of work_costs.status.
 *
 * Two approval levels. Every transition is guarded with optimistic concurrency
 * on the expected status and current_level, so a stale or concurrent action is a
 * clean conflict. Segregation of duties is enforced before any approval is
 * recorded: the submitter cannot approve, and no user may clear two levels of
 * the same cost. Each transition writes an audit_logs row and enqueues the right
 * notification. Money is integer minor units; subtotals are computed here from
 * the items, never taken from the client.
 *
 * Mileage folds in exactly once. If the work order belongs to an LPO with an
 * approved mileage claim and no other non-rejected cost in that LPO has already
 * taken the mileage, this cost carries it. The claim has no consumed column in
 * the schema, so consumption is tracked by which cost holds mileage_minor.
 */
import type { Client } from '@libsql/client/web';
import { enqueue, type SqlExecutor } from '../notify';
import { contractorForUser } from '../repos/techniciansPick';
import { usersWithPermission } from '../repos/approvers';
import { checkApprover } from './sod';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export type CostResult =
  | { ok: true; costId?: string }
  | { ok: false; code: 'not_found' | 'forbidden' | 'invalid' | 'conflict'; message: string };

export interface CostItemInput {
  source: 'PRICE_LIST' | 'QUOTE' | 'MANUAL';
  rateItemId: string | null;
  categoryId: string | null;
  description: string;
  unit: string | null;
  qty: number;
  unitRateMinor: number;
}

interface WorkOrderForCost {
  id: string;
  contractorId: string | null;
  status: string;
  source: string;
  quoteId: string | null;
  lpoId: string | null;
}

async function loadWorkOrder(
  db: Client,
  orgId: string,
  workOrderId: string,
): Promise<WorkOrderForCost | null> {
  const res = await db.execute({
    sql: `SELECT id, contractor_id, status, source, quote_id, lpo_id
            FROM work_orders WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
    args: [workOrderId, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    contractorId: row.contractor_id == null ? null : String(row.contractor_id),
    status: String(row.status),
    source: String(row.source),
    quoteId: row.quote_id == null ? null : String(row.quote_id),
    lpoId: row.lpo_id == null ? null : String(row.lpo_id),
  };
}

interface CostCore {
  id: string;
  workOrderId: string;
  contractorId: string;
  status: string;
  currentLevel: number;
  recallable: boolean;
  subtotalMinor: number;
  mileageMinor: number;
}

async function loadCost(db: SqlExecutor, orgId: string, costId: string): Promise<CostCore | null> {
  const res = await db.execute({
    sql: `SELECT id, work_order_id, contractor_id, status, current_level, recallable,
                 subtotal_minor, mileage_minor
            FROM work_costs WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [costId, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    workOrderId: String(row.work_order_id),
    contractorId: String(row.contractor_id),
    status: String(row.status),
    currentLevel: Number(row.current_level),
    recallable: Number(row.recallable) === 1,
    subtotalMinor: Number(row.subtotal_minor),
    mileageMinor: Number(row.mileage_minor),
  };
}

/** The submitter of a cost, read from the audit trail, for the SoD check. */
async function costSubmitter(
  db: SqlExecutor,
  orgId: string,
  costId: string,
): Promise<string | null> {
  const res = await db.execute({
    sql: `SELECT actor_user_id FROM audit_logs
           WHERE org_id = ? AND entity_type = 'work_cost' AND entity_id = ? AND action = 'cost.submit'
        ORDER BY created_at DESC LIMIT 1`,
    args: [orgId, costId],
  });
  const row = res.rows[0];
  return row && row.actor_user_id != null ? String(row.actor_user_id) : null;
}

async function priorCostApprovers(
  db: SqlExecutor,
  orgId: string,
  costId: string,
): Promise<string[]> {
  const res = await db.execute({
    sql: `SELECT approver_id FROM cost_approvals
           WHERE org_id = ? AND cost_id = ? AND decision = 'APPROVED' AND approver_id IS NOT NULL`,
    args: [orgId, costId],
  });
  return res.rows.map((r) => String(r.approver_id));
}

export async function createCost(
  db: Client,
  ctx: { orgId: string; userId: string },
  workOrderId: string,
): Promise<CostResult> {
  const { orgId } = ctx;
  const contractorId = await contractorForUser(db, orgId, ctx.userId);
  if (!contractorId) return { ok: false, code: 'forbidden', message: 'You are not a contractor.' };

  const wo = await loadWorkOrder(db, orgId, workOrderId);
  if (!wo) return { ok: false, code: 'not_found', message: 'Work order not found.' };
  if (wo.contractorId !== contractorId) {
    return { ok: false, code: 'forbidden', message: 'This work order is not yours.' };
  }
  if (wo.status !== 'CLOSED') {
    return {
      ok: false,
      code: 'conflict',
      message: 'A cost can only be raised for a closed work order.',
    };
  }
  const existing = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM work_costs
           WHERE org_id = ? AND work_order_id = ? AND status != 'REJECTED'`,
    args: [orgId, workOrderId],
  });
  if (Number(existing.rows[0]?.n ?? 0) > 0) {
    return { ok: false, code: 'conflict', message: 'This work order already has a cost.' };
  }

  const basis = wo.source === 'RFQ' && wo.quoteId ? 'QUOTE' : 'AGREED_RATES';
  const quoteId = basis === 'QUOTE' ? wo.quoteId : null;
  const id = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO work_costs
              (id, org_id, work_order_id, contractor_id, costing_basis, quote_id, status, current_level, recallable)
            VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', 0, 1)`,
      args: [id, orgId, workOrderId, contractorId, basis, quoteId],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'cost.create', 'work_cost', ?, ?)`,
      args: [orgId, ctx.userId, id, JSON.stringify({ work_order_id: workOrderId, basis })],
    });
    await tx.commit();
    return { ok: true, costId: id };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/** The mileage to fold into this cost: the LPO's approved claim, once. */
async function mileageToFold(
  tx: SqlExecutor,
  orgId: string,
  costId: string,
  lpoId: string | null,
): Promise<number> {
  if (!lpoId) return 0;
  const claim = await tx.execute({
    sql: `SELECT amount_minor FROM mileage_claims
           WHERE org_id = ? AND lpo_id = ? AND status = 'APPROVED' ORDER BY created_at DESC LIMIT 1`,
    args: [orgId, lpoId],
  });
  if (!claim.rows[0]) return 0;
  const other = await tx.execute({
    sql: `SELECT COUNT(*) AS n FROM work_costs wc
            JOIN work_orders wo ON wo.id = wc.work_order_id
           WHERE wo.lpo_id = ? AND wc.org_id = ? AND wc.id != ? AND wc.status != 'REJECTED'
             AND wc.mileage_minor > 0`,
    args: [lpoId, orgId, costId],
  });
  if (Number(other.rows[0]?.n ?? 0) > 0) return 0; // already taken by another cost
  return Number(claim.rows[0].amount_minor);
}

export async function setCostItems(
  db: Client,
  ctx: { orgId: string; userId: string },
  costId: string,
  items: CostItemInput[],
): Promise<CostResult> {
  const { orgId } = ctx;
  const contractorId = await contractorForUser(db, orgId, ctx.userId);
  if (!contractorId) return { ok: false, code: 'forbidden', message: 'You are not a contractor.' };
  const cost = await loadCost(db, orgId, costId);
  if (!cost) return { ok: false, code: 'not_found', message: 'Cost not found.' };
  if (cost.contractorId !== contractorId) {
    return { ok: false, code: 'forbidden', message: 'This cost is not yours.' };
  }
  if (cost.status !== 'DRAFT' && cost.status !== 'RECALLED') {
    return { ok: false, code: 'conflict', message: 'This cost can no longer be edited.' };
  }

  const clean = items.filter((it) => it.description.trim() !== '');
  const priced = clean.map((it) => ({ ...it, amountMinor: Math.round(it.qty * it.unitRateMinor) }));
  const subtotal = priced.reduce((sum, it) => sum + it.amountMinor, 0);

  const wo = await loadWorkOrder(db, orgId, cost.workOrderId);
  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    const mileage = await mileageToFold(tx, orgId, costId, wo?.lpoId ?? null);
    await tx.execute({
      sql: `DELETE FROM work_cost_items WHERE cost_id = ? AND org_id = ?`,
      args: [costId, orgId],
    });
    for (const it of priced) {
      await tx.execute({
        sql: `INSERT INTO work_cost_items
                (id, org_id, cost_id, source, rate_item_id, category_id, description, unit, qty,
                 unit_rate_minor, amount_minor)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newId(),
          orgId,
          costId,
          it.source,
          it.rateItemId,
          it.categoryId,
          it.description.trim(),
          it.unit,
          it.qty,
          it.unitRateMinor,
          it.amountMinor,
        ],
      });
    }
    await tx.execute({
      sql: `UPDATE work_costs SET subtotal_minor = ?, mileage_minor = ?, total_minor = ?, updated_at = ?
             WHERE id = ? AND org_id = ? AND status IN ('DRAFT','RECALLED')`,
      args: [subtotal, mileage, subtotal + mileage, now, costId, orgId],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'cost.items', 'work_cost', ?, ?)`,
      args: [
        orgId,
        ctx.userId,
        costId,
        JSON.stringify({ subtotal_minor: subtotal, mileage_minor: mileage }),
      ],
    });
    await tx.commit();
    return { ok: true, costId };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

async function notifyUsers(
  tx: SqlExecutor,
  orgId: string,
  userIds: string[],
  templateKey: string,
  subject: string,
  body: string,
  entityId: string,
): Promise<void> {
  for (const userId of userIds) {
    await enqueue(tx, orgId, {
      recipientType: 'user',
      recipientId: userId,
      templateKey,
      subject,
      body,
      entityType: 'work_cost',
      entityId,
    });
  }
}

export async function submitCost(
  db: Client,
  ctx: { orgId: string; userId: string },
  costId: string,
): Promise<CostResult> {
  const { orgId } = ctx;
  const contractorId = await contractorForUser(db, orgId, ctx.userId);
  if (!contractorId) return { ok: false, code: 'forbidden', message: 'You are not a contractor.' };
  const cost = await loadCost(db, orgId, costId);
  if (!cost) return { ok: false, code: 'not_found', message: 'Cost not found.' };
  if (cost.contractorId !== contractorId) {
    return { ok: false, code: 'forbidden', message: 'This cost is not yours.' };
  }
  if (cost.subtotalMinor <= 0) {
    return { ok: false, code: 'invalid', message: 'Add at least one line item before submitting.' };
  }
  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    const moved = await tx.execute({
      sql: `UPDATE work_costs SET status = 'PENDING_L1', current_level = 1, submitted_at = ?, updated_at = ?
             WHERE id = ? AND org_id = ? AND status IN ('DRAFT','RECALLED')`,
      args: [now, now, costId, orgId],
    });
    if (moved.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'This cost can no longer be submitted.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'cost.submit', 'work_cost', ?, ?)`,
      args: [orgId, ctx.userId, costId, JSON.stringify({ status: 'PENDING_L1' })],
    });
    const l1 = await usersWithPermission(tx, orgId, 'cost.approve.l1');
    await notifyUsers(
      tx,
      orgId,
      l1,
      'cost.pending.l1',
      'A work cost needs level 1 approval',
      'A contractor submitted a work cost for approval.',
      costId,
    );
    await tx.commit();
    return { ok: true, costId };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export async function recallCost(
  db: Client,
  ctx: { orgId: string; userId: string },
  costId: string,
): Promise<CostResult> {
  const { orgId } = ctx;
  const contractorId = await contractorForUser(db, orgId, ctx.userId);
  if (!contractorId) return { ok: false, code: 'forbidden', message: 'You are not a contractor.' };
  const cost = await loadCost(db, orgId, costId);
  if (!cost) return { ok: false, code: 'not_found', message: 'Cost not found.' };
  if (cost.contractorId !== contractorId) {
    return { ok: false, code: 'forbidden', message: 'This cost is not yours.' };
  }
  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    const moved = await tx.execute({
      sql: `UPDATE work_costs SET status = 'RECALLED', current_level = 0, updated_at = ?
             WHERE id = ? AND org_id = ? AND recallable = 1 AND status IN ('SUBMITTED','PENDING_L1')`,
      args: [now, costId, orgId],
    });
    if (moved.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'This cost can no longer be recalled.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'cost.recall', 'work_cost', ?, ?)`,
      args: [orgId, ctx.userId, costId, JSON.stringify({ status: 'RECALLED' })],
    });
    await tx.commit();
    return { ok: true, costId };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export async function decideCost(
  db: Client,
  ctx: { orgId: string; userId: string },
  costId: string,
  level: 1 | 2,
  decision: 'approve' | 'reject',
  comment: string,
): Promise<CostResult> {
  const { orgId } = ctx;
  const cost = await loadCost(db, orgId, costId);
  if (!cost) return { ok: false, code: 'not_found', message: 'Cost not found.' };
  const expected = level === 1 ? 'PENDING_L1' : 'PENDING_L2';
  if (cost.status !== expected || cost.currentLevel !== level) {
    return { ok: false, code: 'conflict', message: 'This cost is not awaiting that level.' };
  }

  const submitter = await costSubmitter(db, orgId, costId);
  const priors = await priorCostApprovers(db, orgId, costId);
  const sod = checkApprover({
    actorId: ctx.userId,
    submitterId: submitter,
    priorApproverIds: priors,
  });
  if (!sod.ok)
    return { ok: false, code: 'forbidden', message: sod.reason ?? 'Segregation of duties.' };

  const now = new Date().toISOString();
  const approve = decision === 'approve';
  const nextStatus = approve ? (level === 1 ? 'PENDING_L2' : 'APPROVED') : 'REJECTED';
  const nextLevel = approve ? (level === 1 ? 2 : 2) : cost.currentLevel;

  const tx = await db.transaction('write');
  try {
    const sets =
      approve && level === 2
        ? `status = ?, current_level = ?, approved_at = ?, updated_at = ?`
        : `status = ?, current_level = ?, updated_at = ?`;
    const args =
      approve && level === 2
        ? [nextStatus, nextLevel, now, now, costId, orgId, expected, level]
        : [nextStatus, nextLevel, now, costId, orgId, expected, level];
    const moved = await tx.execute({
      sql: `UPDATE work_costs SET ${sets}
             WHERE id = ? AND org_id = ? AND status = ? AND current_level = ?`,
      args,
    });
    if (moved.rowsAffected === 0) {
      await tx.rollback();
      return {
        ok: false,
        code: 'conflict',
        message: 'This cost changed before the decision completed.',
      };
    }
    await tx.execute({
      sql: `INSERT INTO cost_approvals (id, org_id, cost_id, level, approver_id, decision, comment, decided_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId(),
        orgId,
        costId,
        level,
        ctx.userId,
        approve ? 'APPROVED' : 'REJECTED',
        comment || null,
        now,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'cost.decision', 'work_cost', ?, ?)`,
      args: [orgId, ctx.userId, costId, JSON.stringify({ level, decision, status: nextStatus })],
    });

    if (approve && level === 1) {
      const l2 = await usersWithPermission(tx, orgId, 'cost.approve.l2');
      await notifyUsers(
        tx,
        orgId,
        l2,
        'cost.pending.l2',
        'A work cost needs level 2 approval',
        'A work cost passed level 1 and needs level 2 approval.',
        costId,
      );
    } else {
      await enqueue(tx, orgId, {
        recipientType: 'contractor',
        recipientId: cost.contractorId,
        templateKey: approve ? 'cost.approved' : 'cost.rejected',
        subject: approve ? 'Your work cost was approved' : 'Your work cost was not approved',
        body: approve
          ? 'Your work cost has been approved.'
          : `Your work cost was rejected. ${comment || ''}`.trim(),
        entityType: 'work_cost',
        entityId: costId,
      });
    }
    await tx.commit();
    return { ok: true, costId };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        code: 'conflict',
        message: 'A decision was already recorded at this level.',
      };
    }
    throw err;
  }
}
