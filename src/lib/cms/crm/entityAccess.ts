/**
 * The polymorphic access control: which real row an (entity_type, entity_id)
 * pair names, and whether the caller may touch it.
 *
 * `activities.entity_id` has no foreign key, and neither do the other
 * polymorphic tables. That absence is the security surface of everything
 * built on them: an id from a browser names nothing until this module has
 * checked, in order, that the type is one of the seven the CHECK allows,
 * that the row exists in the table that type names, and that the caller may
 * access it through the Build Prompt 07 scope resolver for that entity's own
 * module. Never in template code, never trusted from a payload.
 *
 * Each entry reuses the module's own predicate where the module exists:
 * accounts, leads and opportunities call the exact functions their modules
 * export. Cases, sales orders and purchase orders have no module yet, so
 * their entries build a predicate from the same resolveScope/scopePredicate
 * machinery against their seeded permission codes; when phases 14 and 17
 * arrive they inherit these entries rather than writing second ones.
 *
 * The check answers with the entity's own account id where the entity has
 * one, because `activities.account_id` is derived here on the server and
 * never accepted from a browser. That derivation is also what makes the
 * account timeline duplicate-free: one activity, one account column, one
 * indexed query.
 */
import type { Client } from '@libsql/client/web';
import { resolveScope, scopePredicate, DENY_ALL, type Predicate } from '../auth/rbac.ts';
import { scopedAccounts } from '../repos/accountAdmin.ts';
import { scopedLeads } from '../repos/leadAdmin.ts';
import { scopedOpportunities } from '../repos/opportunityAdmin.ts';
import { scopedCases } from '../repos/serviceAdmin.ts';
// Phase 20 made the sales order scope canonical in its own module. This file
// imports it rather than keeping the second copy it held while no sales order
// module existed, so the two answer the access question identically.
import { scopedSalesOrders } from '../repos/soPerformance.ts';
import { LEADS_VIEW } from '../permissions.ts';

export const ACTIVITY_ENTITY_TYPES = [
  'ACCOUNT',
  'LEAD',
  'OPPORTUNITY',
  'CASE',
  'SALES_ORDER',
  'PURCHASE_ORDER',
  'CAMPAIGN',
] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

export function isActivityEntityType(value: string): value is ActivityEntityType {
  return (ACTIVITY_ENTITY_TYPES as readonly string[]).includes(value);
}

export type EntityAccess =
  | { readonly ok: true; readonly accountId: string | null; readonly label: string }
  | { readonly ok: false };

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

async function scopedPurchaseOrders(db: Client, userId: string): Promise<Predicate> {
  const resolution = await resolveScope(db, userId, 'ORDERS.PURCHASE_ORDER.VIEW');
  if (!resolution.granted) return DENY_ALL;
  return scopePredicate(resolution, {
    country: 'af.country_id',
    affiliate: 'po.affiliate_id',
    businessUnit: 'po.business_unit_id',
  });
}

/**
 * The registry. One row per entity type: how to fetch the row under the
 * caller's predicate, and where its account and display label live.
 */
export async function resolveEntityAccess(
  db: Client,
  userId: string,
  entityType: string,
  entityId: string,
): Promise<EntityAccess> {
  if (!isActivityEntityType(entityType)) return { ok: false };

  switch (entityType) {
    case 'ACCOUNT': {
      const scope = await scopedAccounts(db, userId);
      const result = await db.execute({
        sql: `SELECT a.account_id, a.account_name FROM accounts a
              WHERE a.account_id = ? AND ${scope.sql} LIMIT 1`,
        args: [entityId, ...scope.args] as never[],
      });
      const row = result.rows[0];
      return row === undefined
        ? { ok: false }
        : { ok: true, accountId: text(row.account_id), label: text(row.account_name) };
    }
    case 'LEAD': {
      const scope = await scopedLeads(db, userId);
      const result = await db.execute({
        sql: `SELECT l.account_id, l.title FROM leads l
              LEFT JOIN accounts a ON a.account_id = l.account_id
              WHERE l.lead_id = ? AND ${scope.sql} LIMIT 1`,
        args: [entityId, ...scope.args] as never[],
      });
      const row = result.rows[0];
      return row === undefined
        ? { ok: false }
        : { ok: true, accountId: nullableText(row.account_id), label: text(row.title) };
    }
    case 'OPPORTUNITY': {
      const scope = await scopedOpportunities(db, userId);
      const result = await db.execute({
        sql: `SELECT o.account_id, o.title FROM opportunities o
              JOIN accounts a ON a.account_id = o.account_id
              WHERE o.opportunity_id = ? AND ${scope.sql} LIMIT 1`,
        args: [entityId, ...scope.args] as never[],
      });
      const row = result.rows[0];
      return row === undefined
        ? { ok: false }
        : { ok: true, accountId: text(row.account_id), label: text(row.title) };
    }
    case 'CASE': {
      const scope = await scopedCases(db, userId);
      const result = await db.execute({
        sql: `SELECT sc.account_id, sc.subject FROM service_cases sc
              JOIN accounts a ON a.account_id = sc.account_id
              WHERE sc.case_id = ? AND ${scope.sql} LIMIT 1`,
        args: [entityId, ...scope.args] as never[],
      });
      const row = result.rows[0];
      return row === undefined
        ? { ok: false }
        : { ok: true, accountId: text(row.account_id), label: text(row.subject) };
    }
    case 'SALES_ORDER': {
      const scope = await scopedSalesOrders(db, userId);
      const result = await db.execute({
        sql: `SELECT so.account_id, so.document_number FROM sales_orders so
              JOIN affiliates af ON af.affiliate_id = so.affiliate_id
              WHERE so.sales_order_id = ? AND ${scope.sql} LIMIT 1`,
        args: [entityId, ...scope.args] as never[],
      });
      const row = result.rows[0];
      return row === undefined
        ? { ok: false }
        : { ok: true, accountId: nullableText(row.account_id), label: text(row.document_number) };
    }
    case 'PURCHASE_ORDER': {
      const scope = await scopedPurchaseOrders(db, userId);
      const result = await db.execute({
        sql: `SELECT po.document_number FROM purchase_orders po
              JOIN affiliates af ON af.affiliate_id = po.affiliate_id
              WHERE po.purchase_order_id = ? AND ${scope.sql} LIMIT 1`,
        args: [entityId, ...scope.args] as never[],
      });
      const row = result.rows[0];
      return row === undefined
        ? { ok: false }
        : { ok: true, accountId: null, label: text(row.document_number) };
    }
    case 'CAMPAIGN': {
      // A campaign is marketing configuration: it names no customer and holds
      // no commercial figure a scope protects. Holding the CRM lead permission
      // at any scope reads it; holding nothing reads nothing.
      const resolution = await resolveScope(db, userId, LEADS_VIEW);
      if (!resolution.granted) return { ok: false };
      const result = await db.execute({
        sql: `SELECT campaign_name FROM campaigns WHERE campaign_id = ? LIMIT 1`,
        args: [entityId],
      });
      const row = result.rows[0];
      return row === undefined
        ? { ok: false }
        : { ok: true, accountId: null, label: text(row.campaign_name) };
    }
  }
}
