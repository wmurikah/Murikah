import type { Client } from '@libsql/client/web';
import type { ApprovalScope } from './approvalSla.ts';

export interface UserResponseLeaderboardRow {
  readonly userId: string;
  readonly person: string;
  readonly responses: number;
  readonly averageMinutes: number;
  readonly fastestMinutes: number;
  readonly slowestMinutes: number;
}

export interface HomeUserLeaderboards {
  readonly purchase: UserResponseLeaderboardRow[];
  readonly loading: UserResponseLeaderboardRow[];
}

const numberOf = (value: unknown): number => Number(value ?? 0);
const textOf = (value: unknown): string => String(value ?? '');

const clamp = (stamp: string, cal: string): string =>
  `MIN(MAX(CAST(strftime('%H', ${stamp}) AS INTEGER) * 60
           + CAST(strftime('%M', ${stamp}) AS INTEGER) - ${cal}.s, 0), ${cal}.w)`;

const elapsed = (from: string, to: string): string =>
  `CASE WHEN ${from} IS NULL OR ${to} IS NULL
             OR CAST(strftime('%s', ${to}) AS INTEGER) < CAST(strftime('%s', ${from}) AS INTEGER)
        THEN NULL
        ELSE (CAST(strftime('%s', ${to}) AS INTEGER)
              - CAST(strftime('%s', ${from}) AS INTEGER)) / 60.0 END`;

/**
 * Same working-day shape used by the Home approval panels: fall back to elapsed
 * time only where no active rule supplies a business calendar.
 */
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

/**
 * One grouped read for both Home leaderboards.
 *
 * Purchase orders use their actual assigned approval users. The Loading
 * Authority side is intentionally user-only as requested, but it never invents
 * the issuer of the final milestone: it ranks the actor-attributed workflow
 * stages that contribute to the Loading Authority process (Finance, Credit and
 * an actual LOADING stage where one is recorded). Historical rows with no
 * Loading Authority actor therefore cannot be mislabelled as somebody else's
 * work.
 */
export async function homeUserLeaderboards(
  db: Client,
  scope: ApprovalScope,
): Promise<HomeUserLeaderboards> {
  const sql = `WITH
    ${calendarCte('po_cal', 'PURCHASE_ORDER')},
    ${calendarCte('so_cal', 'SALES_ORDER')},
    po_rows AS (
      SELECT 'PURCHASE_ORDER' AS process,
             wsi.assigned_user_id AS user_id,
             COALESCE(u.display_name, u.email) AS person,
             ${measured(start, 'wsi.completed_at', 'po_cal')} AS minutes
        FROM workflow_stage_instances wsi
        JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
        JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
        LEFT JOIN purchase_orders po ON po.purchase_order_id = wi.entity_id
        LEFT JOIN users u ON u.user_id = wsi.assigned_user_id
        CROSS JOIN po_cal
       WHERE wi.entity_type = 'PURCHASE_ORDER'
         AND wsi.assigned_user_id IS NOT NULL
         AND wsi.completed_at IS NOT NULL
         AND (:from IS NULL OR wsi.completed_at >= :from)
         AND (:to IS NULL OR wsi.completed_at <= :to)
         AND (:affiliate IS NULL OR po.affiliate_id IS NULL OR po.affiliate_id = :affiliate)
    ),
    loading_rows AS (
      SELECT 'LOADING_AUTHORITY' AS process,
             wsi.assigned_user_id AS user_id,
             COALESCE(u.display_name, u.email) AS person,
             ${measured(start, 'wsi.completed_at', 'so_cal')} AS minutes
        FROM workflow_stage_instances wsi
        JOIN workflow_instances wi ON wi.workflow_instance_id = wsi.workflow_instance_id
        JOIN workflow_stages ws ON ws.workflow_stage_id = wsi.workflow_stage_id
        LEFT JOIN sales_orders so ON so.sales_order_id = wi.entity_id
        LEFT JOIN users u ON u.user_id = wsi.assigned_user_id
        CROSS JOIN so_cal
       WHERE wi.entity_type = 'SALES_ORDER'
         AND ws.stage_code IN ('FINANCE_APPROVAL', 'CREDIT_CHECK', 'LOADING', 'LOADING_AUTHORITY')
         AND wsi.assigned_user_id IS NOT NULL
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
    SELECT combined.process,
           combined.user_id,
           MAX(combined.person) AS person,
           COUNT(combined.minutes) AS responses,
           AVG(combined.minutes) AS average_minutes,
           MIN(combined.minutes) AS fastest_minutes,
           MAX(combined.minutes) AS slowest_minutes
      FROM combined
     WHERE combined.minutes IS NOT NULL
     GROUP BY combined.process, combined.user_id
     ORDER BY combined.process, average_minutes, responses DESC`;

  const found = await db.execute({
    sql,
    args: {
      from: scope.from === null ? null : `${scope.from} 00:00:00`,
      to: scope.to === null ? null : `${scope.to} 23:59:59`,
      affiliate: scope.affiliateId,
    },
  });

  const purchase: UserResponseLeaderboardRow[] = [];
  const loading: UserResponseLeaderboardRow[] = [];
  for (const raw of found.rows as Record<string, unknown>[]) {
    const row: UserResponseLeaderboardRow = {
      userId: textOf(raw.user_id),
      person: textOf(raw.person),
      responses: numberOf(raw.responses),
      averageMinutes: numberOf(raw.average_minutes),
      fastestMinutes: numberOf(raw.fastest_minutes),
      slowestMinutes: numberOf(raw.slowest_minutes),
    };
    if (raw.process === 'PURCHASE_ORDER') purchase.push(row);
    else if (raw.process === 'LOADING_AUTHORITY') loading.push(row);
  }

  const rank = (a: UserResponseLeaderboardRow, b: UserResponseLeaderboardRow) =>
    a.averageMinutes - b.averageMinutes || b.responses - a.responses || a.person.localeCompare(b.person);
  purchase.sort(rank);
  loading.sort(rank);
  return { purchase, loading };
}
