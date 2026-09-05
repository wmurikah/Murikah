import type { Client } from '@libsql/client/web';
import type { ApprovalScope } from './approvalSla.ts';

export type LeaderboardProcess = 'PURCHASE_ORDER' | 'LOADING_AUTHORITY';

export interface UserResponseDetailRow {
  readonly process: LeaderboardProcess;
  readonly userId: string;
  readonly person: string;
  readonly entityId: string;
  readonly documentNumber: string;
  readonly stageCode: string;
  readonly stageName: string;
  readonly affiliateCode: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly minutes: number;
}

const textOf = (value: unknown): string => String(value ?? '');
const nullableText = (value: unknown): string | null =>
  value === null || value === undefined || String(value).trim() === '' ? null : String(value);

const clamp = (stamp: string, cal: string): string =>
  `MIN(MAX(CAST(strftime('%H', ${stamp}) AS INTEGER) * 60
           + CAST(strftime('%M', ${stamp}) AS INTEGER) - ${cal}.s, 0), ${cal}.w)`;

const elapsed = (from: string, to: string): string =>
  `CASE WHEN ${from} IS NULL OR ${to} IS NULL
             OR CAST(strftime('%s', ${to}) AS INTEGER) < CAST(strftime('%s', ${from}) AS INTEGER)
        THEN NULL
        ELSE (CAST(strftime('%s', ${to}) AS INTEGER)
              - CAST(strftime('%s', ${from}) AS INTEGER)) / 60.0 END`;

const measured = (from: string, to: string, cal: string): string => `
  CASE WHEN ${from} IS NULL OR ${to} IS NULL
             OR CAST(strftime('%s', ${to}) AS INTEGER) < CAST(strftime('%s', ${from}) AS INTEGER)
       THEN NULL
       WHEN ${cal}.s IS NULL THEN ${elapsed(from, to)}
       ELSE CAST(ROUND(julianday(date(${to})) - julianday(date(${from}))) AS INTEGER) * ${cal}.w
            + ${clamp(to, cal)} - ${clamp(from, cal)}
  END`;

const calendarCte = (name: string, entityType: 'PURCHASE_ORDER' | 'SALES_ORDER'): string => `
  ${name} AS (
    SELECT
      (SELECT CAST(substr(c.workday_start, 1, 2) AS INTEGER) * 60
                    + CAST(substr(c.workday_start, 4, 2) AS INTEGER)
         FROM sla_rules r
         JOIN business_calendars c ON c.business_calendar_id = r.business_calendar_id
        WHERE r.entity_type = '${entityType}' AND r.active = 1
        ORDER BY r.sla_rule_id LIMIT 1) AS s,
      (SELECT (CAST(substr(c.workday_end, 1, 2) AS INTEGER) * 60
                    + CAST(substr(c.workday_end, 4, 2) AS INTEGER))
                    - (CAST(substr(c.workday_start, 1, 2) AS INTEGER) * 60
                       + CAST(substr(c.workday_start, 4, 2) AS INTEGER))
         FROM sla_rules r
         JOIN business_calendars c ON c.business_calendar_id = r.business_calendar_id
        WHERE r.entity_type = '${entityType}' AND r.active = 1
        ORDER BY r.sla_rule_id LIMIT 1) AS w
  )`;

const start = 'COALESCE(wsi.started_at, wsi.assigned_at)';

export async function homeUserLeaderboardDetails(
  db: Client,
  scope: ApprovalScope,
  process: LeaderboardProcess,
  userId: string,
): Promise<UserResponseDetailRow[]> {
  const sql = `WITH
    ${calendarCte('po_cal', 'PURCHASE_ORDER')},
    ${calendarCte('so_cal', 'SALES_ORDER')},
    po_rows AS (
      SELECT 'PURCHASE_ORDER' AS process,
             wsi.assigned_user_id AS user_id,
             COALESCE(u.display_name, u.email) AS person,
             wi.entity_id AS entity_id,
             po.document_number AS document_number,
             ws.stage_code AS stage_code,
             ws.stage_name AS stage_name,
             a.affiliate_code AS affiliate_code,
             ${start} AS started_at,
             wsi.completed_at AS completed_at,
             ${measured(start, 'wsi.completed_at', 'po_cal')} AS minutes
        FROM workflow_stage_instances wsi
        JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
        JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
        LEFT JOIN purchase_orders po ON po.purchase_order_id = wi.entity_id
        LEFT JOIN affiliates a ON a.affiliate_id = po.affiliate_id
        LEFT JOIN users u ON u.user_id = wsi.assigned_user_id
        CROSS JOIN po_cal
       WHERE wi.entity_type = 'PURCHASE_ORDER'
         AND wsi.assigned_user_id = :user
         AND wsi.completed_at IS NOT NULL
         AND (:from IS NULL OR wsi.completed_at >= :from)
         AND (:to IS NULL OR wsi.completed_at <= :to)
         AND (:affiliate IS NULL OR po.affiliate_id IS NULL OR po.affiliate_id = :affiliate)
    ),
    loading_rows AS (
      SELECT 'LOADING_AUTHORITY' AS process,
             wsi.assigned_user_id AS user_id,
             COALESCE(u.display_name, u.email) AS person,
             wi.entity_id AS entity_id,
             so.document_number AS document_number,
             ws.stage_code AS stage_code,
             ws.stage_name AS stage_name,
             a.affiliate_code AS affiliate_code,
             ${start} AS started_at,
             wsi.completed_at AS completed_at,
             ${measured(start, 'wsi.completed_at', 'so_cal')} AS minutes
        FROM workflow_stage_instances wsi
        JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
        JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
        LEFT JOIN sales_orders so ON so.sales_order_id = wi.entity_id
        LEFT JOIN affiliates a ON a.affiliate_id = so.affiliate_id
        LEFT JOIN users u ON u.user_id = wsi.assigned_user_id
        CROSS JOIN so_cal
       WHERE wi.entity_type = 'SALES_ORDER'
         AND ws.stage_code IN ('FINANCE_APPROVAL', 'CREDIT_CHECK', 'LOADING', 'LOADING_AUTHORITY')
         AND wsi.assigned_user_id = :user
         AND wsi.completed_at IS NOT NULL
         AND (:from IS NULL OR wsi.completed_at >= :from)
         AND (:to IS NULL OR wsi.completed_at <= :to)
         AND (:affiliate IS NULL OR so.affiliate_id = :affiliate)
    ),
    combined AS (
      SELECT * FROM po_rows
      UNION ALL
      SELECT * FROM loading_rows
    )
    SELECT process, user_id, person, entity_id, document_number, stage_code, stage_name,
           affiliate_code, started_at, completed_at, minutes
      FROM combined
     WHERE process = :process AND minutes IS NOT NULL
     ORDER BY completed_at DESC
     LIMIT 500`;

  const found = await db.execute({
    sql,
    args: {
      process,
      user: userId,
      from: scope.from === null ? null : `${scope.from} 00:00:00`,
      to: scope.to === null ? null : `${scope.to} 23:59:59`,
      affiliate: scope.affiliateId,
    },
  });

  return (found.rows as Record<string, unknown>[]).map((raw) => ({
    process: raw.process === 'PURCHASE_ORDER' ? 'PURCHASE_ORDER' : 'LOADING_AUTHORITY',
    userId: textOf(raw.user_id),
    person: textOf(raw.person),
    entityId: textOf(raw.entity_id),
    documentNumber: textOf(raw.document_number),
    stageCode: textOf(raw.stage_code),
    stageName: textOf(raw.stage_name),
    affiliateCode: nullableText(raw.affiliate_code),
    startedAt: textOf(raw.started_at),
    completedAt: textOf(raw.completed_at),
    minutes: Number(raw.minutes ?? 0),
  }));
}
