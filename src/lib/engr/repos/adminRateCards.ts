/**
 * Rate cards admin and their rate items. Org-scoped reads and writes; every write
 * records an audit_logs row in the same transaction. A rate card is either tied
 * to a contractor or left org-wide (contractor_id NULL). Rate items hang off a
 * card and carry the card's currency, so pricing stays consistent.
 */
import type { Client } from '@libsql/client/web';

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

function isUniqueViolation(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err);
  return text.includes('UNIQUE') || text.includes('SQLITE_CONSTRAINT');
}

export type AdminResult =
  | { ok: true; id?: string }
  | { ok: false; code: 'conflict' | 'invalid' | 'not_found'; message: string };

export interface RateCardRow {
  id: string;
  name: string;
  contractorName: string | null;
  currency: string;
  status: string;
  itemCount: number;
}

export interface RateCardDetail {
  id: string;
  name: string;
  contractorId: string | null;
  currency: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  status: string;
}

export interface RateItemRow {
  id: string;
  description: string;
  unit: string | null;
  categoryName: string | null;
  unitRateMinor: number;
  currency: string;
}

export interface RateCardInput {
  name: string;
  contractorId: string | null;
  currency: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  status: string;
}

export interface RateItemInput {
  rateCardId: string;
  categoryId: string | null;
  description: string;
  unit: string | null;
  unitRateMinor: number;
}

export async function listRateCardsAdmin(db: Client, orgId: string): Promise<RateCardRow[]> {
  const res = await db.execute({
    sql: `SELECT rc.id, rc.name, rc.currency, rc.status,
                 c.name AS contractor_name,
                 (SELECT COUNT(*) FROM rate_items ri
                   WHERE ri.rate_card_id = rc.id AND ri.org_id = rc.org_id) AS item_count
            FROM rate_cards rc
            LEFT JOIN contractors c ON c.id = rc.contractor_id
           WHERE rc.org_id = ?
        ORDER BY rc.name`,
    args: [orgId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    contractorName: r.contractor_name === null ? null : String(r.contractor_name),
    currency: String(r.currency),
    status: String(r.status),
    itemCount: Number(r.item_count),
  }));
}

export async function getRateCard(
  db: Client,
  orgId: string,
  id: string,
): Promise<RateCardDetail | null> {
  const res = await db.execute({
    sql: `SELECT id, name, contractor_id, currency, effective_from, effective_to, status
            FROM rate_cards WHERE id = ? AND org_id = ? LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    contractorId: row.contractor_id === null ? null : String(row.contractor_id),
    currency: String(row.currency),
    effectiveFrom: row.effective_from === null ? null : String(row.effective_from),
    effectiveTo: row.effective_to === null ? null : String(row.effective_to),
    status: String(row.status),
  };
}

export async function listRateItems(
  db: Client,
  orgId: string,
  cardId: string,
): Promise<RateItemRow[]> {
  const res = await db.execute({
    sql: `SELECT ri.id, ri.description, ri.unit, ri.unit_rate_minor, ri.currency,
                 ac.name AS category_name
            FROM rate_items ri
            LEFT JOIN asset_categories ac ON ac.id = ri.category_id
           WHERE ri.org_id = ? AND ri.rate_card_id = ?
        ORDER BY ri.created_at`,
    args: [orgId, cardId],
  });
  return res.rows.map((r) => ({
    id: String(r.id),
    description: String(r.description),
    unit: r.unit === null ? null : String(r.unit),
    categoryName: r.category_name === null ? null : String(r.category_name),
    unitRateMinor: Number(r.unit_rate_minor),
    currency: String(r.currency),
  }));
}

const STATUSES = new Set(['ACTIVE', 'ARCHIVED']);

function validateCard(input: RateCardInput): string | null {
  if (!input.name) return 'A name is required.';
  if (!input.currency) return 'A currency is required.';
  if (!STATUSES.has(input.status)) return 'Choose a valid status.';
  return null;
}

export async function createRateCard(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: RateCardInput,
): Promise<AdminResult> {
  const invalid = validateCard(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const id = newId();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO rate_cards (id, org_id, contractor_id, name, currency, effective_from, effective_to, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        ctx.orgId,
        input.contractorId,
        input.name,
        input.currency,
        input.effectiveFrom,
        input.effectiveTo,
        input.status,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'rates.create', 'rate_card', ?, ?)`,
      args: [
        ctx.orgId,
        ctx.userId,
        id,
        JSON.stringify({ name: input.name, contractor_id: input.contractorId }),
      ],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That rate card already exists.' };
    throw err;
  }
}

export async function updateRateCard(
  db: Client,
  ctx: { orgId: string; userId: string },
  id: string,
  input: RateCardInput,
): Promise<AdminResult> {
  const invalid = validateCard(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const tx = await db.transaction('write');
  try {
    const upd = await tx.execute({
      sql: `UPDATE rate_cards
               SET contractor_id = ?, name = ?, currency = ?, effective_from = ?, effective_to = ?, status = ?
             WHERE id = ? AND org_id = ?`,
      args: [
        input.contractorId,
        input.name,
        input.currency,
        input.effectiveFrom,
        input.effectiveTo,
        input.status,
        id,
        ctx.orgId,
      ],
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return { ok: false, code: 'not_found', message: 'That rate card was not found.' };
    }
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'rates.update', 'rate_card', ?, ?)`,
      args: [
        ctx.orgId,
        ctx.userId,
        id,
        JSON.stringify({ name: input.name, contractor_id: input.contractorId }),
      ],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That rate card already exists.' };
    throw err;
  }
}

function validateItem(input: RateItemInput): string | null {
  if (!input.rateCardId) return 'A rate card is required.';
  if (!input.description) return 'A description is required.';
  return null;
}

export async function addRateItem(
  db: Client,
  ctx: { orgId: string; userId: string },
  input: RateItemInput,
): Promise<AdminResult> {
  const invalid = validateItem(input);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const id = newId();
  const tx = await db.transaction('write');
  try {
    const card = await tx.execute({
      sql: `SELECT currency FROM rate_cards WHERE id = ? AND org_id = ? LIMIT 1`,
      args: [input.rateCardId, ctx.orgId],
    });
    const cardRow = card.rows[0];
    if (!cardRow) {
      await tx.rollback();
      return { ok: false, code: 'not_found', message: 'That rate card was not found.' };
    }
    const currency = String(cardRow.currency);
    await tx.execute({
      sql: `INSERT INTO rate_items (id, org_id, rate_card_id, category_id, description, unit, unit_rate_minor, currency)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        ctx.orgId,
        input.rateCardId,
        input.categoryId,
        input.description,
        input.unit,
        input.unitRateMinor,
        currency,
      ],
    });
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, after_json)
            VALUES (?, ?, 'rates.item.add', 'rate_item', ?, ?)`,
      args: [
        ctx.orgId,
        ctx.userId,
        id,
        JSON.stringify({ rate_card_id: input.rateCardId, description: input.description }),
      ],
    });
    await tx.commit();
    return { ok: true, id };
  } catch (err) {
    await tx.rollback();
    if (isUniqueViolation(err))
      return { ok: false, code: 'conflict', message: 'That rate item already exists.' };
    throw err;
  }
}
