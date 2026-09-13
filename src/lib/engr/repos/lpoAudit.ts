/**
 * The audit-grade LPO lifecycle: approve, issue and seal, cancel, amend and
 * verify. The document state is expressed through timestamp columns
 * (approved_at, issued_at, sealed_at, cancelled_at) and the supersedes chain,
 * keeping the existing status enum for operational grouping.
 *
 * At issue, in one transaction, the covered work orders are frozen into lpo_lines
 * as a text-and-number snapshot, the total is reconciled to lines plus approved
 * mileage, a deterministic seal hash is computed over a canonical serialisation,
 * and issued_at and sealed_at are stamped. After that the document is immutable:
 * a change is a new version linked by supersedes_id / superseded_by_id, and a
 * cancellation is a status and reason, never a delete. Every action is audited.
 *
 * These columns and the lpo_lines table are applied by an operator migration and
 * are read and written directly; every query is scoped by the acting organisation.
 */
import type { Client } from '@libsql/client/web';
import { enqueue } from '../notify';
import { reconcile, sealHash, type SealInput, type SealLine } from '../lpoSeal';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

export type LpoState = 'DRAFT' | 'APPROVED' | 'ISSUED' | 'AMENDED' | 'CANCELLED';

export type LpoAuditResult =
  | { ok: true; lpoId?: string; lpoNo?: string }
  | { ok: false; code: 'not_found' | 'invalid' | 'conflict' | 'forbidden'; message: string };

export interface LpoLine {
  workOrderId: string | null;
  woNo: string;
  stationId: string | null;
  stationName: string;
  assetId: string | null;
  assetTag: string | null;
  categoryId: string | null;
  categoryName: string | null;
  slaId: string | null;
  slaName: string | null;
  description: string;
  amountMinor: number;
  currency: string;
}

// A work order's frozen description, synthesised from its asset or category since
// a work order carries no free-text description of its own.
function lineDescription(assetName: string | null, categoryName: string | null): string {
  return assetName ?? categoryName ?? 'Site maintenance';
}

// ---- header ----------------------------------------------------------------

interface LpoHeader {
  id: string;
  lpoNo: string;
  version: number;
  status: string;
  currency: string;
  contractorId: string;
  baseStationId: string | null;
  regionId: string | null;
  totalMinor: number;
  approvedAt: string | null;
  issuedAt: string | null;
  sealedAt: string | null;
  cancelledAt: string | null;
  supersededById: string | null;
}

async function loadHeader(db: Client, orgId: string, lpoId: string): Promise<LpoHeader | null> {
  const res = await db.execute({
    sql: `SELECT id, lpo_no, version, status, currency, contractor_id, base_station_id, region_id,
                 total_minor, approved_at, issued_at, sealed_at, cancelled_at, superseded_by_id
            FROM lpos WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [lpoId, orgId],
  });
  const r = res.rows[0];
  if (!r) return null;
  const orNull = (v: unknown): string | null => (v == null ? null : String(v));
  return {
    id: String(r.id),
    lpoNo: String(r.lpo_no),
    version: Number(r.version ?? 1),
    status: String(r.status),
    currency: String(r.currency),
    contractorId: String(r.contractor_id),
    baseStationId: orNull(r.base_station_id),
    regionId: orNull(r.region_id),
    totalMinor: Number(r.total_minor ?? 0),
    approvedAt: orNull(r.approved_at),
    issuedAt: orNull(r.issued_at),
    sealedAt: orNull(r.sealed_at),
    cancelledAt: orNull(r.cancelled_at),
    supersededById: orNull(r.superseded_by_id),
  };
}

export function deriveState(h: {
  approvedAt: string | null;
  sealedAt: string | null;
  cancelledAt: string | null;
  supersededById: string | null;
}): LpoState {
  if (h.cancelledAt) return 'CANCELLED';
  if (h.supersededById) return 'AMENDED';
  if (h.sealedAt) return 'ISSUED';
  if (h.approvedAt) return 'APPROVED';
  return 'DRAFT';
}

// ---- lines and mileage ------------------------------------------------------

/** The live draft lines: the covered work orders with their approved cost amount. */
export async function listLpoLinesLive(
  db: Client,
  orgId: string,
  lpoId: string,
  lpoCurrency: string,
): Promise<LpoLine[]> {
  const res = await db.execute({
    sql: `SELECT wo.id AS wo_id, wo.wo_no, wo.station_id, st.name AS station_name,
                 wo.asset_id, a.tag AS asset_tag, a.name AS asset_name,
                 wo.category_id, cat.name AS category_name,
                 wo.sla_id, sla.name AS sla_name,
                 COALESCE((SELECT SUM(wc.total_minor) FROM work_costs wc
                            WHERE wc.work_order_id = wo.id AND wc.org_id = wo.org_id
                              AND wc.status = 'APPROVED'), 0) AS amount_minor,
                 COALESCE((SELECT wc.currency FROM work_costs wc
                            WHERE wc.work_order_id = wo.id AND wc.org_id = wo.org_id
                              AND wc.status = 'APPROVED' LIMIT 1), ?) AS currency
            FROM work_orders wo
            JOIN stations st ON st.id = wo.station_id
            LEFT JOIN assets a ON a.id = wo.asset_id
            LEFT JOIN asset_categories cat ON cat.id = wo.category_id
            LEFT JOIN slas sla ON sla.id = wo.sla_id
           WHERE wo.lpo_id = ? AND wo.org_id = ? AND wo.deleted_at IS NULL
        ORDER BY wo.wo_no`,
    args: [lpoCurrency, lpoId, orgId],
  });
  const orNull = (v: unknown): string | null => (v == null ? null : String(v));
  return res.rows.map((w) => ({
    workOrderId: String(w.wo_id),
    woNo: String(w.wo_no),
    stationId: orNull(w.station_id),
    stationName: w.station_name == null ? '' : String(w.station_name),
    assetId: orNull(w.asset_id),
    assetTag: orNull(w.asset_tag),
    categoryId: orNull(w.category_id),
    categoryName: orNull(w.category_name),
    slaId: orNull(w.sla_id),
    slaName: orNull(w.sla_name),
    description: lineDescription(orNull(w.asset_name), orNull(w.category_name)),
    amountMinor: Number(w.amount_minor ?? 0),
    currency: String(w.currency),
  }));
}

/** The frozen lines snapshotted into lpo_lines at issue. */
export async function listLpoLinesFrozen(
  db: Client,
  orgId: string,
  lpoId: string,
): Promise<LpoLine[]> {
  const res = await db.execute({
    sql: `SELECT work_order_id, wo_no, station_id, station_name, asset_id, asset_tag,
                 category_id, category_name, sla_id, sla_name, description, amount_minor, currency
            FROM lpo_lines WHERE lpo_id = ? AND org_id = ? ORDER BY wo_no`,
    args: [lpoId, orgId],
  });
  const orNull = (v: unknown): string | null => (v == null ? null : String(v));
  return res.rows.map((l) => ({
    workOrderId: orNull(l.work_order_id),
    woNo: String(l.wo_no),
    stationId: orNull(l.station_id),
    stationName: l.station_name == null ? '' : String(l.station_name),
    assetId: orNull(l.asset_id),
    assetTag: orNull(l.asset_tag),
    categoryId: orNull(l.category_id),
    categoryName: orNull(l.category_name),
    slaId: orNull(l.sla_id),
    slaName: orNull(l.sla_name),
    description: String(l.description),
    amountMinor: Number(l.amount_minor ?? 0),
    currency: String(l.currency),
  }));
}

export interface ApprovedMileage {
  amountMinor: number;
  currency: string;
}

async function approvedMileage(
  db: Client,
  orgId: string,
  lpoId: string,
): Promise<ApprovedMileage | null> {
  const res = await db.execute({
    sql: `SELECT amount_minor, currency FROM mileage_claims
           WHERE lpo_id = ? AND org_id = ? AND status = 'APPROVED'
        ORDER BY created_at DESC LIMIT 1`,
    args: [lpoId, orgId],
  });
  const r = res.rows[0];
  if (!r) return null;
  return { amountMinor: Number(r.amount_minor ?? 0), currency: String(r.currency) };
}

const toSealLine = (l: LpoLine): SealLine => ({
  woNo: l.woNo,
  stationName: l.stationName,
  assetTag: l.assetTag,
  categoryName: l.categoryName,
  slaName: l.slaName,
  description: l.description,
  amountMinor: l.amountMinor,
});

// ---- approve ----------------------------------------------------------------

/** Approve a draft. An LPO is a financial commitment, so it must be approved
 *  before it can be issued. */
export async function approveLpo(
  db: Client,
  ctx: { orgId: string; userId: string },
  lpoId: string,
): Promise<LpoAuditResult> {
  const { orgId } = ctx;
  const h = await loadHeader(db, orgId, lpoId);
  if (!h) return { ok: false, code: 'not_found', message: 'LPO not found.' };
  if (h.cancelledAt) return { ok: false, code: 'conflict', message: 'This LPO is cancelled.' };
  if (h.sealedAt) return { ok: false, code: 'conflict', message: 'This LPO is already issued.' };
  if (h.approvedAt)
    return { ok: false, code: 'conflict', message: 'This LPO is already approved.' };

  const lines = await listLpoLinesLive(db, orgId, lpoId, h.currency);
  if (lines.length === 0) {
    return { ok: false, code: 'invalid', message: 'Add at least one work order before approving.' };
  }

  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    const upd = await tx.execute({
      sql: `UPDATE lpos SET approved_by = ?, approved_at = ?, updated_at = ?
             WHERE id = ? AND org_id = ? AND approved_at IS NULL AND sealed_at IS NULL AND cancelled_at IS NULL`,
      args: [ctx.userId, now, now, lpoId, orgId],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return {
        ok: false,
        code: 'conflict',
        message: 'The LPO could not be approved. Refresh and try again.',
      };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'lpo.approve', 'lpo', ?, ?)`,
      args: [orgId, ctx.userId, lpoId, JSON.stringify({ lpo_no: h.lpoNo, approved_at: now })],
    });
    await tx.commit();
    return { ok: true, lpoId, lpoNo: h.lpoNo };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

// ---- issue and seal ---------------------------------------------------------

export async function issueLpo(
  db: Client,
  ctx: { orgId: string; userId: string },
  lpoId: string,
): Promise<LpoAuditResult> {
  const { orgId } = ctx;
  const h = await loadHeader(db, orgId, lpoId);
  if (!h) return { ok: false, code: 'not_found', message: 'LPO not found.' };
  if (h.cancelledAt) return { ok: false, code: 'conflict', message: 'This LPO is cancelled.' };
  if (h.sealedAt)
    return { ok: false, code: 'conflict', message: 'This LPO is already issued and sealed.' };
  if (!h.approvedAt) {
    return {
      ok: false,
      code: 'conflict',
      message: 'An LPO must be approved before it can be issued.',
    };
  }

  const lines = await listLpoLinesLive(db, orgId, lpoId, h.currency);
  if (lines.length === 0) {
    return { ok: false, code: 'invalid', message: 'Add at least one work order before issuing.' };
  }
  // Single currency per LPO, never crossed.
  const crossed = lines.find((l) => l.amountMinor > 0 && l.currency !== h.currency);
  if (crossed) {
    return {
      ok: false,
      code: 'invalid',
      message: `Work order ${crossed.woNo} is in ${crossed.currency}, not the LPO currency ${h.currency}.`,
    };
  }
  const mileage = await approvedMileage(db, orgId, lpoId);
  if (mileage && mileage.amountMinor > 0 && mileage.currency !== h.currency) {
    return { ok: false, code: 'invalid', message: 'The mileage currency does not match the LPO.' };
  }
  const mileageMinor = mileage?.amountMinor ?? 0;

  // Reconcile: the sealed total is the lines sum plus mileage, so it always ties.
  const { subtotalMinor, expectedTotal } = reconcile(lines, mileageMinor, h.totalMinor);
  const totalMinor = expectedTotal;

  const issuedAt = new Date().toISOString();
  const sealInput: SealInput = {
    lpoNo: h.lpoNo,
    version: h.version,
    contractorId: h.contractorId,
    baseStationId: h.baseStationId,
    regionId: h.regionId,
    currency: h.currency,
    subtotalMinor,
    mileageMinor,
    totalMinor,
    issuedAt,
    lines: lines.map(toSealLine),
  };
  const hash = await sealHash(sealInput);

  const tx = await db.transaction('write');
  try {
    for (const l of lines) {
      await tx.execute({
        sql: `INSERT INTO lpo_lines
                (id, org_id, lpo_id, work_order_id, wo_no, station_id, station_name, asset_id, asset_tag,
                 category_id, category_name, sla_id, sla_name, description, amount_minor, currency)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newId(),
          orgId,
          lpoId,
          l.workOrderId,
          l.woNo,
          l.stationId,
          l.stationName,
          l.assetId,
          l.assetTag,
          l.categoryId,
          l.categoryName,
          l.slaId,
          l.slaName,
          l.description,
          l.amountMinor,
          l.currency,
        ],
      });
    }
    const upd = await tx.execute({
      sql: `UPDATE lpos
               SET subtotal_minor = ?, mileage_minor = ?, total_minor = ?, issued_by = ?, issued_at = ?,
                   sealed_hash = ?, sealed_at = ?, status = 'IN_PROGRESS', updated_at = ?
             WHERE id = ? AND org_id = ? AND approved_at IS NOT NULL AND sealed_at IS NULL AND cancelled_at IS NULL`,
      args: [
        subtotalMinor,
        mileageMinor,
        totalMinor,
        ctx.userId,
        issuedAt,
        hash,
        issuedAt,
        issuedAt,
        lpoId,
        orgId,
      ],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return {
        ok: false,
        code: 'conflict',
        message: 'The LPO could not be issued. Refresh and try again.',
      };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'lpo.issue', 'lpo', ?, ?)`,
      args: [
        orgId,
        ctx.userId,
        lpoId,
        JSON.stringify({
          lpo_no: h.lpoNo,
          total_minor: totalMinor,
          sealed_hash: hash,
          lines: lines.length,
        }),
      ],
    });
    await enqueue(tx, orgId, {
      recipientType: 'contractor',
      recipientId: h.contractorId,
      templateKey: 'lpo.issued',
      subject: `LPO ${h.lpoNo} issued`,
      body: `LPO ${h.lpoNo} has been issued and sealed. It covers ${lines.length} work order(s).`,
      entityType: 'lpo',
      entityId: lpoId,
    });
    await tx.commit();
    return { ok: true, lpoId, lpoNo: h.lpoNo };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

// ---- cancel -----------------------------------------------------------------

export async function cancelLpo(
  db: Client,
  ctx: { orgId: string; userId: string },
  lpoId: string,
  reason: string,
): Promise<LpoAuditResult> {
  const { orgId } = ctx;
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    return { ok: false, code: 'invalid', message: 'Give a reason for cancelling.' };
  }
  const h = await loadHeader(db, orgId, lpoId);
  if (!h) return { ok: false, code: 'not_found', message: 'LPO not found.' };
  if (h.cancelledAt)
    return { ok: false, code: 'conflict', message: 'This LPO is already cancelled.' };

  const now = new Date().toISOString();
  const tx = await db.transaction('write');
  try {
    const upd = await tx.execute({
      sql: `UPDATE lpos SET cancelled_at = ?, cancel_reason = ?, status = 'CANCELLED', updated_at = ?
             WHERE id = ? AND org_id = ? AND cancelled_at IS NULL`,
      args: [now, trimmed, now, lpoId, orgId],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'conflict', message: 'The LPO could not be cancelled.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'lpo.cancel', 'lpo', ?, ?)`,
      args: [orgId, ctx.userId, lpoId, JSON.stringify({ lpo_no: h.lpoNo, reason: trimmed })],
    });
    await tx.commit();
    return { ok: true, lpoId, lpoNo: h.lpoNo };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

// ---- amend ------------------------------------------------------------------

/**
 * The only way to change a sealed LPO: open a new version. A fresh draft is
 * created as version n plus one, linked by supersedes_id / superseded_by_id, and
 * the covered work orders move to it so the raiser can adjust and re-issue. Both
 * rows remain; the sealed original keeps its frozen lines as the record.
 */
export async function amendLpo(
  db: Client,
  ctx: { orgId: string; userId: string },
  lpoId: string,
): Promise<LpoAuditResult> {
  const { orgId } = ctx;
  const h = await loadHeader(db, orgId, lpoId);
  if (!h) return { ok: false, code: 'not_found', message: 'LPO not found.' };
  if (!h.sealedAt)
    return { ok: false, code: 'conflict', message: 'Only a sealed LPO can be amended.' };
  if (h.supersededById) {
    return { ok: false, code: 'conflict', message: 'This LPO has already been amended.' };
  }

  // Copy the header fields onto a new draft (region, notes, base station, currency).
  const src = await db.execute({
    sql: `SELECT base_station_id, region_id, notes, currency FROM lpos WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [lpoId, orgId],
  });
  const s = src.rows[0];
  if (!s) return { ok: false, code: 'not_found', message: 'LPO not found.' };

  const year = new Date().getUTCFullYear();
  const countRes = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM lpos WHERE org_id = ? AND lpo_no LIKE ?`,
    args: [orgId, `LPO-${year}-%`],
  });
  const base = Number(countRes.rows[0]?.n ?? 0);
  const now = new Date().toISOString();

  for (let attempt = 0; attempt < 5; attempt++) {
    const lpoNo = `LPO-${year}-${String(base + 1 + attempt).padStart(4, '0')}`;
    const newLpoId = newId();
    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `INSERT INTO lpos
                (id, org_id, lpo_no, contractor_id, created_by, base_station_id, region_id, notes,
                 currency, version, status, supersedes_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
        args: [
          newLpoId,
          orgId,
          lpoNo,
          h.contractorId,
          ctx.userId,
          s.base_station_id ?? null,
          s.region_id ?? null,
          s.notes ?? null,
          h.currency,
          h.version + 1,
          lpoId,
        ],
      });
      const link = await tx.execute({
        sql: `UPDATE lpos SET superseded_by_id = ?, updated_at = ?
               WHERE id = ? AND org_id = ? AND superseded_by_id IS NULL AND sealed_at IS NOT NULL`,
        args: [newLpoId, now, lpoId, orgId],
      });
      if (link.rowsAffected === 0) {
        await tx.rollback();
        return { ok: false, code: 'conflict', message: 'This LPO has already been amended.' };
      }
      // The live work orders move to the new draft; the sealed original keeps its
      // frozen lpo_lines, so its record is untouched.
      await tx.execute({
        sql: `UPDATE work_orders SET lpo_id = ?, updated_at = ? WHERE lpo_id = ? AND org_id = ?`,
        args: [newLpoId, now, lpoId, orgId],
      });
      await tx.execute({
        sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
              VALUES (?, ?, 'lpo.amend', 'lpo', ?, ?)`,
        args: [
          orgId,
          ctx.userId,
          newLpoId,
          JSON.stringify({ lpo_no: lpoNo, version: h.version + 1, supersedes: h.lpoNo }),
        ],
      });
      await tx.commit();
      return { ok: true, lpoId: newLpoId, lpoNo };
    } catch (err) {
      await tx.rollback();
      const text = String(err instanceof Error ? err.message : err);
      if ((text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT')) && attempt < 4) continue;
      throw err;
    }
  }
  return { ok: false, code: 'conflict', message: 'Could not allocate an LPO number.' };
}

// ---- verify -----------------------------------------------------------------

export interface VerifyResult {
  state: 'verified' | 'changed' | 'unsealed';
  storedHash: string | null;
  recomputedHash: string | null;
}

export async function verifyLpoSeal(
  db: Client,
  orgId: string,
  lpoId: string,
): Promise<VerifyResult> {
  const res = await db.execute({
    sql: `SELECT lpo_no, version, contractor_id, base_station_id, region_id, currency,
                 subtotal_minor, mileage_minor, total_minor, issued_at, sealed_hash
            FROM lpos WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [lpoId, orgId],
  });
  const r = res.rows[0];
  if (!r || r.sealed_hash == null || r.issued_at == null) {
    return { state: 'unsealed', storedHash: null, recomputedHash: null };
  }
  const orNull = (v: unknown): string | null => (v == null ? null : String(v));
  const frozen = await listLpoLinesFrozen(db, orgId, lpoId);
  const recomputed = await sealHash({
    lpoNo: String(r.lpo_no),
    version: Number(r.version ?? 1),
    contractorId: String(r.contractor_id),
    baseStationId: orNull(r.base_station_id),
    regionId: orNull(r.region_id),
    currency: String(r.currency),
    subtotalMinor: Number(r.subtotal_minor ?? 0),
    mileageMinor: Number(r.mileage_minor ?? 0),
    totalMinor: Number(r.total_minor ?? 0),
    issuedAt: String(r.issued_at),
    lines: frozen.map(toSealLine),
  });
  const storedHash = String(r.sealed_hash);
  return {
    state: recomputed === storedHash ? 'verified' : 'changed',
    storedHash,
    recomputedHash: recomputed,
  };
}

// ---- audit detail -----------------------------------------------------------

export interface LpoAuditDetail {
  id: string;
  lpoNo: string;
  version: number;
  state: LpoState;
  status: string;
  contractorId: string;
  contractorName: string;
  baseStationName: string | null;
  regionName: string | null;
  notes: string | null;
  currency: string;
  subtotalMinor: number;
  mileageMinor: number;
  totalMinor: number;
  reconciles: boolean;
  lines: LpoLine[];
  frozen: boolean;
  createdByName: string | null;
  createdAt: string;
  approvedByName: string | null;
  approvedAt: string | null;
  issuedByName: string | null;
  issuedAt: string | null;
  sealedAt: string | null;
  sealedHash: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  supersedesId: string | null;
  supersedesNo: string | null;
  supersededById: string | null;
  supersededByNo: string | null;
}

export async function getLpoAuditDetail(
  db: Client,
  orgId: string,
  lpoId: string,
): Promise<LpoAuditDetail | null> {
  const res = await db.execute({
    sql: `SELECT l.*, c.name AS contractor_name, bs.name AS base_station_name, rg.name AS region_name,
                 cu.full_name AS created_name, au.full_name AS approved_name, iu.full_name AS issued_name,
                 sup.lpo_no AS supersedes_no, supby.lpo_no AS superseded_by_no
            FROM lpos l
            JOIN contractors c ON c.id = l.contractor_id
            LEFT JOIN stations bs ON bs.id = l.base_station_id
            LEFT JOIN regions rg ON rg.id = l.region_id
            LEFT JOIN users cu ON cu.id = l.created_by
            LEFT JOIN users au ON au.id = l.approved_by
            LEFT JOIN users iu ON iu.id = l.issued_by
            LEFT JOIN lpos sup ON sup.id = l.supersedes_id
            LEFT JOIN lpos supby ON supby.id = l.superseded_by_id
           WHERE l.id = ? AND l.org_id = ? LIMIT 1`,
    args: [lpoId, orgId],
  });
  const r = res.rows[0];
  if (!r) return null;
  const orNull = (v: unknown): string | null => (v == null ? null : String(v));

  const sealedAt = orNull(r.sealed_at);
  const currency = String(r.currency);
  const frozen = sealedAt != null;
  const lines = frozen
    ? await listLpoLinesFrozen(db, orgId, lpoId)
    : await listLpoLinesLive(db, orgId, lpoId, currency);

  const subtotalMinor = Number(r.subtotal_minor ?? 0);
  const mileageMinor = Number(r.mileage_minor ?? 0);
  const totalMinor = Number(r.total_minor ?? 0);
  // For a draft, derive the running figures from the live lines and mileage.
  const linesSum = lines.reduce((s, l) => s + l.amountMinor, 0);
  const liveMileage = frozen
    ? mileageMinor
    : ((await approvedMileage(db, orgId, lpoId))?.amountMinor ?? 0);
  const shownSubtotal = frozen ? subtotalMinor : linesSum;
  const shownMileage = frozen ? mileageMinor : liveMileage;
  const shownTotal = frozen ? totalMinor : linesSum + liveMileage;
  const rec = reconcile(lines, shownMileage, shownTotal);

  const header = {
    approvedAt: orNull(r.approved_at),
    sealedAt,
    cancelledAt: orNull(r.cancelled_at),
    supersededById: orNull(r.superseded_by_id),
  };

  return {
    id: String(r.id),
    lpoNo: String(r.lpo_no),
    version: Number(r.version ?? 1),
    state: deriveState(header),
    status: String(r.status),
    contractorId: String(r.contractor_id),
    contractorName: String(r.contractor_name),
    baseStationName: orNull(r.base_station_name),
    regionName: orNull(r.region_name),
    notes: orNull(r.notes),
    currency,
    subtotalMinor: shownSubtotal,
    mileageMinor: shownMileage,
    totalMinor: shownTotal,
    reconciles: rec.ok,
    lines,
    frozen,
    createdByName: orNull(r.created_name),
    createdAt: String(r.created_at),
    approvedByName: orNull(r.approved_name),
    approvedAt: orNull(r.approved_at),
    issuedByName: orNull(r.issued_name),
    issuedAt: orNull(r.issued_at),
    sealedAt,
    sealedHash: orNull(r.sealed_hash),
    cancelledAt: orNull(r.cancelled_at),
    cancelReason: orNull(r.cancel_reason),
    supersedesId: orNull(r.supersedes_id),
    supersedesNo: orNull(r.supersedes_no),
    supersededById: orNull(r.superseded_by_id),
    supersededByNo: orNull(r.superseded_by_no),
  };
}
