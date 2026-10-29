import type { Client } from '@libsql/client/web';
import { DUE_SQL } from './activityAdmin.ts';
import { scopedOpportunities } from './opportunityAdmin.ts';

const text = (value: unknown): string => String(value ?? '');
const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);
const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export interface OpportunityWorkspaceProduct {
  productName: string;
  expectedQuantity: number;
  unitOfMeasure: string | null;
}

export interface OpportunityWorkspaceContext {
  opportunityId: string;
  affiliateCode: string | null;
  affiliateName: string | null;
  industry: string | null;
  segment: string | null;
  creditDays: number | null;
  products: OpportunityWorkspaceProduct[];
  nextActivitySummary: string | null;
  nextAction: string | null;
  nextActivityDue: string | null;
}

/**
 * Enrich the CRM workspace with commercial context for opportunities that have
 * already been returned by a scoped opportunity read.
 *
 * The ids are still re-checked against the canonical opportunity scope here so
 * this helper remains safe if another page calls it later. Three grouped reads
 * run in one batch: customer context, product demand and the next open activity.
 * There are no per-opportunity queries and no write or schema operation.
 */
export async function opportunityWorkspaceContext(
  db: Client,
  userId: string,
  opportunityIds: readonly string[],
): Promise<Map<string, OpportunityWorkspaceContext>> {
  const ids = [...new Set(opportunityIds.filter((id) => id !== ''))];
  if (ids.length === 0) return new Map();

  const scope = await scopedOpportunities(db, userId);
  const placeholders = ids.map(() => '?').join(', ');
  const scopedArgs = [...ids, ...scope.args] as never[];

  const [accounts, products, activities] = await db.batch(
    [
      {
        sql: `SELECT o.opportunity_id, af.affiliate_code, af.affiliate_name,
                     a.industry, a.segment, a.credit_days
              FROM opportunities o
              JOIN accounts a ON a.account_id = o.account_id
              LEFT JOIN affiliates af ON af.affiliate_id = a.affiliate_id
              WHERE o.opportunity_id IN (${placeholders}) AND ${scope.sql}
              ORDER BY o.opportunity_id`,
        args: scopedArgs,
      },
      {
        sql: `SELECT o.opportunity_id, p.product_name, p.unit_of_measure,
                     op.expected_quantity
              FROM opportunities o
              JOIN accounts a ON a.account_id = o.account_id
              JOIN opportunity_products op ON op.opportunity_id = o.opportunity_id
              JOIN products p ON p.product_id = op.product_id
              WHERE o.opportunity_id IN (${placeholders}) AND ${scope.sql}
              ORDER BY o.opportunity_id, p.product_name`,
        args: scopedArgs,
      },
      {
        sql: `SELECT o.opportunity_id, act.summary, act.next_action,
                     ${DUE_SQL} AS due_at, act.created_at
              FROM opportunities o
              JOIN accounts a ON a.account_id = o.account_id
              JOIN activities act
                ON act.entity_type = 'OPPORTUNITY' AND act.entity_id = o.opportunity_id
              WHERE o.opportunity_id IN (${placeholders})
                AND ${scope.sql}
                AND act.completed_at IS NULL
              ORDER BY o.opportunity_id,
                       ${DUE_SQL} IS NULL,
                       ${DUE_SQL},
                       act.created_at DESC`,
        args: scopedArgs,
      },
    ],
    'read',
  );

  const result = new Map<string, OpportunityWorkspaceContext>();
  for (const raw of accounts.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const opportunityId = text(row.opportunity_id);
    result.set(opportunityId, {
      opportunityId,
      affiliateCode: nullableText(row.affiliate_code),
      affiliateName: nullableText(row.affiliate_name),
      industry: nullableText(row.industry),
      segment: nullableText(row.segment),
      creditDays: nullableNumber(row.credit_days),
      products: [],
      nextActivitySummary: null,
      nextAction: null,
      nextActivityDue: null,
    });
  }

  for (const raw of products.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const context = result.get(text(row.opportunity_id));
    if (context === undefined) continue;
    context.products.push({
      productName: text(row.product_name),
      expectedQuantity: Number(row.expected_quantity ?? 0),
      unitOfMeasure: nullableText(row.unit_of_measure),
    });
  }

  const actionSeen = new Set<string>();
  for (const raw of activities.rows) {
    const row = raw as unknown as Record<string, unknown>;
    const opportunityId = text(row.opportunity_id);
    if (actionSeen.has(opportunityId)) continue;
    const context = result.get(opportunityId);
    if (context === undefined) continue;
    actionSeen.add(opportunityId);
    context.nextActivitySummary = nullableText(row.summary);
    context.nextAction = nullableText(row.next_action);
    context.nextActivityDue = nullableText(row.due_at);
  }

  return result;
}
