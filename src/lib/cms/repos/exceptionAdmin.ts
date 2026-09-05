import type { Client } from '@libsql/client/web';
import { toDbTimestamp } from '../auth/session.ts';
import { scopedSlaInstances } from './slaAdmin.ts';

export type ExceptionBucket = 'all' | 'at-risk' | 'breached' | 'unassigned' | 'escalated';

export interface ExceptionRow {
  slaInstanceId: string;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  customerName: string | null;
  ruleName: string;
  slaType: string;
  status: string;
  targetAt: string;
  warningAt: string | null;
  stoppedAt: string | null;
  accountableUserName: string | null;
  accountableTeamName: string | null;
  escalated: boolean;
}

export interface ExceptionQuery {
  bucket: ExceptionBucket;
  slaType: string | null;
  entityType: string | null;
  page: number;
}

const text = (value: unknown): string => String(value ?? '');
const nullableText = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

const SELECT = `
  SELECT i.sla_instance_id, i.entity_type, i.entity_id, i.status, i.target_at,
         i.warning_at, i.stopped_at, r.rule_name, p.sla_type,
         au.display_name AS accountable_user_name, tm.team_name AS accountable_team_name,
         COALESCE(sc.subject, l.title, so.document_number, po.document_number) AS entity_label,
         COALESCE(a_case.account_name, a_lead.account_name, a_so.account_name) AS customer_name,
         CASE WHEN EXISTS (
           SELECT 1 FROM sla_escalation_events se WHERE se.sla_instance_id = i.sla_instance_id
         ) THEN 1 ELSE 0 END AS escalated
  FROM sla_instances i
  JOIN sla_rules r ON r.sla_rule_id = i.sla_rule_id
  JOIN sla_profiles p ON p.sla_profile_id = r.sla_profile_id
  LEFT JOIN users au ON au.user_id = i.accountable_user_id
  LEFT JOIN teams tm ON tm.team_id = i.accountable_team_id
  LEFT JOIN service_cases sc ON i.entity_type = 'CASE' AND sc.case_id = i.entity_id
  LEFT JOIN accounts a_case ON a_case.account_id = sc.account_id
  LEFT JOIN leads l ON i.entity_type = 'LEAD' AND l.lead_id = i.entity_id
  LEFT JOIN accounts a_lead ON a_lead.account_id = l.account_id
  LEFT JOIN sales_orders so ON i.entity_type = 'SALES_ORDER' AND so.sales_order_id = i.entity_id
  LEFT JOIN accounts a_so ON a_so.account_id = so.account_id
  LEFT JOIN affiliates af_so ON af_so.affiliate_id = so.affiliate_id
  LEFT JOIN purchase_orders po ON i.entity_type = 'PURCHASE_ORDER' AND po.purchase_order_id = i.entity_id
  LEFT JOIN affiliates af_po ON af_po.affiliate_id = po.affiliate_id`;

export async function listExceptions(
  db: Client,
  userId: string,
  query: ExceptionQuery,
  now: Date,
): Promise<{ items: ExceptionRow[]; total: number; page: number; pageSize: number }> {
  const scope = await scopedSlaInstances(db, userId);
  const clauses: string[] = [scope.sql];
  const args: unknown[] = [...scope.args];
  const stamp = toDbTimestamp(now);

  if (query.slaType !== null) {
    clauses.push('p.sla_type = ?');
    args.push(query.slaType);
  }
  if (query.entityType !== null) {
    clauses.push('i.entity_type = ?');
    args.push(query.entityType);
  }

  const atRisk = `(i.status = 'RUNNING' AND i.warning_at IS NOT NULL AND i.warning_at <= ?)`;
  const breached = `(i.status = 'BREACHED')`;
  const unassigned = `(i.status IN ('RUNNING','PAUSED') AND i.accountable_user_id IS NULL AND i.accountable_team_id IS NULL)`;
  const escalated = `EXISTS (SELECT 1 FROM sla_escalation_events se WHERE se.sla_instance_id = i.sla_instance_id)`;

  switch (query.bucket) {
    case 'at-risk':
      clauses.push(atRisk);
      args.push(stamp);
      break;
    case 'breached':
      clauses.push(breached);
      break;
    case 'unassigned':
      clauses.push(unassigned);
      break;
    case 'escalated':
      clauses.push(escalated);
      break;
    case 'all':
      clauses.push(`(${atRisk} OR ${breached} OR ${unassigned} OR ${escalated})`);
      args.push(stamp);
      break;
  }

  const where = clauses.join(' AND ');
  const pageSize = 25;
  const [counted, rows] = await Promise.all([
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM (${SELECT} WHERE ${where})`,
      args: args as never[],
    }),
    db.execute({
      sql: `${SELECT} WHERE ${where}
            ORDER BY
              CASE
                WHEN i.status = 'BREACHED' THEN 0
                WHEN EXISTS (SELECT 1 FROM sla_escalation_events se2 WHERE se2.sla_instance_id = i.sla_instance_id) THEN 1
                WHEN i.accountable_user_id IS NULL AND i.accountable_team_id IS NULL THEN 2
                ELSE 3
              END,
              i.target_at
            LIMIT ? OFFSET ?`,
      args: [...args, pageSize, (query.page - 1) * pageSize] as never[],
    }),
  ]);

  return {
    items: rows.rows.map((raw) => {
      const row = raw as unknown as Record<string, unknown>;
      return {
        slaInstanceId: text(row.sla_instance_id),
        entityType: text(row.entity_type),
        entityId: text(row.entity_id),
        entityLabel: nullableText(row.entity_label),
        customerName: nullableText(row.customer_name),
        ruleName: text(row.rule_name),
        slaType: text(row.sla_type),
        status: text(row.status),
        targetAt: text(row.target_at),
        warningAt: nullableText(row.warning_at),
        stoppedAt: nullableText(row.stopped_at),
        accountableUserName: nullableText(row.accountable_user_name),
        accountableTeamName: nullableText(row.accountable_team_name),
        escalated: Number(row.escalated ?? 0) === 1,
      };
    }),
    total: Number(counted.rows[0]?.n ?? 0),
    page: query.page,
    pageSize,
  };
}
