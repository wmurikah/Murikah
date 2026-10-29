/**
 * Mileage claims. The defining rule of this workflow is one claim for the whole
 * LPO trip, not one per station, so there is a guarded one-active-claim-per-LPO
 * check (the schema has no unique constraint for it). The amount is always
 * computed server-side from distance and the per-kilometre rate; a client amount
 * is never trusted. There is no station-distance matrix in the schema, so the
 * contractor enters the distance and the approver verifies it. Org-scoped, and a
 * contractor may act only on their own LPO's claim.
 */
import type { Client } from '@libsql/client/web';
import { enqueue } from '../notify';
import { contractorForUser } from './techniciansPick';
import { mileageAmountMinor } from '../mileage';
import { recomputeTotal } from './lpos';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

export type ClaimResult =
  | { ok: true; claimId?: string }
  | { ok: false; code: 'not_found' | 'forbidden' | 'invalid' | 'conflict'; message: string };

/** The org's per-kilometre mileage rate in minor units, from org_settings. */
export async function mileageRateMinor(db: Client, orgId: string): Promise<number> {
  const res = await db.execute({
    sql: `SELECT value_json FROM org_settings WHERE org_id = ? AND key = 'mileage_rate_per_km_minor' LIMIT 1`,
    args: [orgId],
  });
  const raw = res.rows[0]?.value_json;
  if (typeof raw !== 'string') return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0)
      return Math.round(parsed);
    if (parsed && typeof parsed === 'object' && 'minor' in parsed) {
      const minor = (parsed as { minor: unknown }).minor;
      if (typeof minor === 'number' && Number.isFinite(minor) && minor >= 0)
        return Math.round(minor);
    }
  } catch {
    // Malformed setting: treat as no rate configured.
  }
  return 0;
}

interface LpoOwner {
  contractorId: string;
  baseStationId: string | null;
  status: string;
}

async function loadLpoOwner(db: Client, orgId: string, lpoId: string): Promise<LpoOwner | null> {
  const res = await db.execute({
    sql: `SELECT contractor_id, base_station_id, status FROM lpos WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [lpoId, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    contractorId: String(row.contractor_id),
    baseStationId: row.base_station_id == null ? null : String(row.base_station_id),
    status: String(row.status),
  };
}

/** Raise one mileage claim for the LPO trip, at DRAFT. One active claim per LPO. */
export async function raiseClaim(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: { lpoId: string; referencedToStationId: string | null; distanceKm: number },
): Promise<ClaimResult> {
  const { orgId } = ctx;
  const contractorId = await contractorForUser(db, orgId, ctx.userId);
  if (!contractorId) return { ok: false, code: 'forbidden', message: 'You are not a contractor.' };

  const lpo = await loadLpoOwner(db, orgId, input.lpoId);
  if (!lpo) return { ok: false, code: 'not_found', message: 'LPO not found.' };
  if (lpo.contractorId !== contractorId) {
    return { ok: false, code: 'forbidden', message: 'This LPO is not yours.' };
  }
  if (lpo.status === 'CANCELLED') {
    return { ok: false, code: 'conflict', message: 'This LPO is cancelled.' };
  }
  if (!(input.distanceKm > 0)) {
    return { ok: false, code: 'invalid', message: 'Enter the trip distance in kilometres.' };
  }

  // One active claim per LPO: block unless the only existing one is rejected.
  const existing = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM mileage_claims
           WHERE org_id = ? AND lpo_id = ? AND status != 'REJECTED'`,
    args: [orgId, input.lpoId],
  });
  if (Number(existing.rows[0]?.n ?? 0) > 0) {
    return { ok: false, code: 'conflict', message: 'This LPO already has a mileage claim.' };
  }

  const rate = await mileageRateMinor(db, orgId);
  const amount = mileageAmountMinor(input.distanceKm, rate);

  // Link the claim to the work order at the referenced station, when there is one,
  // so the costing prompt can attach the mileage to that work-order cost.
  let workOrderId: string | null = null;
  if (input.referencedToStationId) {
    const wo = await db.execute({
      sql: `SELECT id FROM work_orders
             WHERE lpo_id = ? AND org_id = ? AND station_id = ? AND deleted_at IS NULL LIMIT 1`,
      args: [input.lpoId, orgId, input.referencedToStationId],
    });
    if (wo.rows[0]) workOrderId = String(wo.rows[0].id);
  }

  const claimId = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO mileage_claims
              (id, org_id, lpo_id, work_order_id, base_station_id, referenced_to_station_id,
               distance_km, rate_per_km_minor, amount_minor, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT')`,
      args: [
        claimId,
        orgId,
        input.lpoId,
        workOrderId,
        lpo.baseStationId,
        input.referencedToStationId,
        input.distanceKm,
        rate,
        amount,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'mileage.raise', 'mileage_claim', ?, ?)`,
      args: [
        orgId,
        ctx.userId,
        claimId,
        JSON.stringify({ lpo_id: input.lpoId, amount_minor: amount }),
      ],
    });
    await tx.commit();
    return { ok: true, claimId };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/** Submit the contractor's own DRAFT claim for an LPO, notifying the approver. */
export async function submitClaim(
  db: Client,
  ctx: { orgId: string; userId: string },
  lpoId: string,
): Promise<ClaimResult> {
  const { orgId } = ctx;
  const contractorId = await contractorForUser(db, orgId, ctx.userId);
  if (!contractorId) return { ok: false, code: 'forbidden', message: 'You are not a contractor.' };
  const lpo = await loadLpoOwner(db, orgId, lpoId);
  if (!lpo) return { ok: false, code: 'not_found', message: 'LPO not found.' };
  if (lpo.contractorId !== contractorId) {
    return { ok: false, code: 'forbidden', message: 'This LPO is not yours.' };
  }

  const claim = await db.execute({
    sql: `SELECT id FROM mileage_claims WHERE org_id = ? AND lpo_id = ? AND status = 'DRAFT' LIMIT 1`,
    args: [orgId, lpoId],
  });
  const claimRow = claim.rows[0];
  if (!claimRow)
    return { ok: false, code: 'conflict', message: 'There is no draft claim to submit.' };
  const claimId = String(claimRow.id);

  const tx = await db.transaction('write');
  try {
    const moved = await tx.execute({
      sql: `UPDATE mileage_claims SET status = 'SUBMITTED' WHERE id = ? AND org_id = ? AND status = 'DRAFT'`,
      args: [claimId, orgId],
    });
    if (moved.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'This claim can no longer be submitted.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'mileage.submit', 'mileage_claim', ?, ?)`,
      args: [orgId, ctx.userId, claimId, JSON.stringify({ lpo_id: lpoId })],
    });
    // Notify the engineers who can approve a cost (cost.approve.l1).
    const approvers = await tx.execute({
      sql: `SELECT DISTINCT u.id AS id
              FROM users u
              JOIN user_roles ur ON ur.user_id = u.id
              JOIN roles r ON r.id = ur.role_id
              JOIN role_permissions rp ON rp.role_id = r.id
              JOIN permissions p ON p.id = rp.permission_id
             WHERE u.org_id = ? AND u.status = 'ACTIVE'
               AND p.key = 'cost.approve.l1' AND (r.org_id IS NULL OR r.org_id = ?)`,
      args: [orgId, orgId],
    });
    for (const row of approvers.rows) {
      await enqueue(tx, orgId, {
        recipientType: 'user',
        recipientId: String(row.id),
        templateKey: 'mileage.submitted',
        subject: 'A mileage claim needs approval',
        body: 'A contractor submitted a mileage claim for an LPO trip.',
        entityType: 'mileage_claim',
        entityId: claimId,
      });
    }
    await tx.commit();
    return { ok: true, claimId };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

interface ClaimCore {
  id: string;
  lpoId: string;
  distanceKm: number;
  ratePerKmMinor: number;
  status: string;
}

async function loadClaim(db: Client, orgId: string, claimId: string): Promise<ClaimCore | null> {
  const res = await db.execute({
    sql: `SELECT id, lpo_id, distance_km, rate_per_km_minor, status
            FROM mileage_claims WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [claimId, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    lpoId: row.lpo_id == null ? '' : String(row.lpo_id),
    distanceKm: Number(row.distance_km),
    ratePerKmMinor: Number(row.rate_per_km_minor),
    status: String(row.status),
  };
}

async function notifyClaimContractor(
  tx: Awaited<ReturnType<Client['transaction']>>,
  orgId: string,
  lpoId: string,
  templateKey: string,
  subject: string,
  body: string,
  claimId: string,
): Promise<void> {
  const lpo = await tx.execute({
    sql: `SELECT contractor_id FROM lpos WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [lpoId, orgId],
  });
  const contractorId = lpo.rows[0]?.contractor_id;
  if (contractorId != null) {
    await enqueue(tx, orgId, {
      recipientType: 'contractor',
      recipientId: String(contractorId),
      templateKey,
      subject,
      body,
      entityType: 'mileage_claim',
      entityId: claimId,
    });
  }
}

/**
 * Approve a submitted claim. The approver may override the distance and the rate
 * (the only place the rate can change); the amount is recomputed server-side.
 * Guarded on SUBMITTED so a second approver is a clean conflict. On approval the
 * amount stands as a cost line for the costing prompt, and the LPO total is
 * recomputed.
 */
export async function approveClaim(
  db: Client,
  ctx: { orgId: string; userId: string },
  claimId: string,
  overrides: { distanceKm?: number | null; ratePerKmMinor?: number | null },
): Promise<ClaimResult> {
  const { orgId } = ctx;
  const claim = await loadClaim(db, orgId, claimId);
  if (!claim) return { ok: false, code: 'not_found', message: 'Claim not found.' };
  if (claim.status !== 'SUBMITTED') {
    return { ok: false, code: 'conflict', message: 'Only a submitted claim can be approved.' };
  }
  const distance =
    overrides.distanceKm != null && overrides.distanceKm > 0
      ? overrides.distanceKm
      : claim.distanceKm;
  const rate =
    overrides.ratePerKmMinor != null && overrides.ratePerKmMinor >= 0
      ? overrides.ratePerKmMinor
      : claim.ratePerKmMinor;
  const amount = mileageAmountMinor(distance, rate);

  const tx = await db.transaction('write');
  try {
    const moved = await tx.execute({
      sql: `UPDATE mileage_claims
               SET status = 'APPROVED', distance_km = ?, rate_per_km_minor = ?, amount_minor = ?
             WHERE id = ? AND org_id = ? AND status = 'SUBMITTED'`,
      args: [distance, rate, amount, claimId, orgId],
    });
    if (moved.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'This claim was already decided.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'mileage.approve', 'mileage_claim', ?, ?)`,
      args: [
        orgId,
        ctx.userId,
        claimId,
        JSON.stringify({ amount_minor: amount, distance_km: distance, rate_per_km_minor: rate }),
      ],
    });
    await notifyClaimContractor(
      tx,
      orgId,
      claim.lpoId,
      'mileage.approved',
      'Mileage claim approved',
      'Your mileage claim was approved.',
      claimId,
    );
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
  // Fold the approved amount into the LPO total for the costing prompt.
  if (claim.lpoId) await recomputeTotal(db, orgId, claim.lpoId);
  return { ok: true, claimId };
}

export async function rejectClaim(
  db: Client,
  ctx: { orgId: string; userId: string },
  claimId: string,
  reason: string,
): Promise<ClaimResult> {
  const { orgId } = ctx;
  const claim = await loadClaim(db, orgId, claimId);
  if (!claim) return { ok: false, code: 'not_found', message: 'Claim not found.' };
  if (claim.status !== 'SUBMITTED') {
    return { ok: false, code: 'conflict', message: 'Only a submitted claim can be rejected.' };
  }
  const tx = await db.transaction('write');
  try {
    const moved = await tx.execute({
      sql: `UPDATE mileage_claims SET status = 'REJECTED' WHERE id = ? AND org_id = ? AND status = 'SUBMITTED'`,
      args: [claimId, orgId],
    });
    if (moved.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'This claim was already decided.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'mileage.reject', 'mileage_claim', ?, ?)`,
      args: [orgId, ctx.userId, claimId, JSON.stringify({ reason: reason || null })],
    });
    await notifyClaimContractor(
      tx,
      orgId,
      claim.lpoId,
      'mileage.rejected',
      'Mileage claim not approved',
      'Your mileage claim was not approved. You can raise a corrected claim.',
      claimId,
    );
    await tx.commit();
    return { ok: true, claimId };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export interface PendingClaimRow {
  id: string;
  lpoId: string;
  lpoNo: string;
  contractorName: string;
  distanceKm: number;
  ratePerKmMinor: number;
  amountMinor: number;
  currency: string;
  baseStationName: string | null;
  referencedStationName: string | null;
}

export async function listPendingClaims(db: Client, orgId: string): Promise<PendingClaimRow[]> {
  const res = await db.execute({
    sql: `SELECT m.id, m.distance_km, m.rate_per_km_minor, m.amount_minor, m.currency,
                 l.id AS lpo_id, l.lpo_no, c.name AS contractor_name,
                 b.name AS base_name, r.name AS ref_name
            FROM mileage_claims m
            JOIN lpos l ON l.id = m.lpo_id
            JOIN contractors c ON c.id = l.contractor_id
            LEFT JOIN stations b ON b.id = m.base_station_id
            LEFT JOIN stations r ON r.id = m.referenced_to_station_id
           WHERE m.org_id = ? AND m.status = 'SUBMITTED'
        ORDER BY m.created_at LIMIT 200`,
    args: [orgId],
  });
  return res.rows.map((row) => ({
    id: String(row.id),
    lpoId: String(row.lpo_id),
    lpoNo: String(row.lpo_no),
    contractorName: String(row.contractor_name),
    distanceKm: Number(row.distance_km),
    ratePerKmMinor: Number(row.rate_per_km_minor),
    amountMinor: Number(row.amount_minor),
    currency: String(row.currency),
    baseStationName: row.base_name == null ? null : String(row.base_name),
    referencedStationName: row.ref_name == null ? null : String(row.ref_name),
  }));
}
