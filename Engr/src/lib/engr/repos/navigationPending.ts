/**
 * Live sidebar counters. A count is a distinct record the signed-in actor can
 * move forward now, not a total of all open records or unread messages.
 * All statements are scoped to the active organisation, current permissions,
 * and (for portal roles) the user's linked station/contractor/technician.
 *
 * Keep these state predicates aligned with the existing workflow endpoints.
 * This is a read-only presentation layer; it never changes workflow state.
 */
import type { Client } from '@libsql/client/web';
import { actorDataScope } from '../auth/dataScope';

export type PendingNavKey =
  | 'requests'
  | 'workorders'
  | 'rfqs'
  | 'maintenance'
  | 'lpos'
  | 'stationConfirmations'
  | 'procurementApprovals'
  | 'mileageApprovals'
  | 'costApprovals'
  | 'billApprovals'
  | 'costs'
  | 'bills'
  | 'payments'
  | 'assetTransfers';

export type PendingNavCounts = Partial<Record<PendingNavKey, number>>;

export interface PendingNavActor {
  orgId: string;
  userId: string;
  roles: readonly string[];
  perms: readonly string[];
}

export interface CountStatement {
  key: PendingNavKey;
  sql: string;
  args: Array<string | number>;
}

/** Build the authorised queries before contacting Turso; no client-supplied filters. */
export function pendingNavigationPlan(actor: PendingNavActor, today: string): CountStatement[] {
  const { orgId, userId } = actor;
  const has = (permission: string) => actor.perms.includes(permission);
  const scope = actorDataScope(actor.roles);
  const statements: CountStatement[] = [];
  const add = (key: PendingNavKey, sql: string, args: Array<string | number> = [orgId]) =>
    statements.push({ key, sql, args });

  if (scope === 'org' && has('requests.view')) {
    const conditions: string[] = [];
    const args: Array<string | number> = [orgId];
    if (has('requests.accept') || has('requests.reject')) {
      conditions.push("(sr.status = 'OPEN' AND sr.raised_by <> ?)");
      args.push(userId);
    }
    if (has('workorder.create') || has('rfq.create')) {
      conditions.push("(sr.status = 'ACCEPTED' AND (sr.assigned_engineer_id = ? OR sr.assigned_engineer_id IS NULL) AND NOT EXISTS (SELECT 1 FROM work_orders wo WHERE wo.org_id = sr.org_id AND wo.request_id = sr.id AND wo.deleted_at IS NULL) AND NOT EXISTS (SELECT 1 FROM rfqs rq WHERE rq.org_id = sr.org_id AND rq.request_id = sr.id AND rq.status <> 'CANCELLED'))");
      args.push(userId);
    }
    if (conditions.length)
      add('requests', "SELECT COUNT(*) AS n FROM service_requests sr WHERE sr.org_id = ? AND sr.deleted_at IS NULL AND (" + conditions.join(' OR ') + ')', args);
  }

  if (has('workorder.view')) {
    if (scope === 'contractor' && (has('workorder.accept') || has('workorder.assign_technician')))
      add('workorders', "SELECT COUNT(*) AS n FROM work_orders wo JOIN contractors c ON c.id = wo.contractor_id AND c.org_id = wo.org_id WHERE wo.org_id = ? AND wo.deleted_at IS NULL AND c.portal_user_id = ? AND ((wo.status = 'CONTRACTOR_NOTIFIED' AND ? = 1) OR (wo.status = 'CONTRACTOR_ACCEPTED' AND ? = 1))", [orgId, userId, Number(has('workorder.accept')), Number(has('workorder.assign_technician'))]);
    else if (scope === 'technician' && has('workorder.execute'))
      add('workorders', "SELECT COUNT(*) AS n FROM work_orders wo JOIN technicians t ON t.id = wo.technician_id AND t.org_id = wo.org_id WHERE wo.org_id = ? AND wo.deleted_at IS NULL AND t.portal_user_id = ? AND (wo.status IN ('TECH_ASSIGNED', 'TECH_ONSITE', 'IN_PROGRESS') OR (wo.status = 'TECH_ACCEPTED' AND ? = 1 AND NOT EXISTS (SELECT 1 FROM job_safety_analyses j WHERE j.org_id = wo.org_id AND j.work_order_id = wo.id AND j.arrival_requested_at IS NOT NULL)))", [orgId, userId, Number(has('jsa.submit'))]);
    else if (scope === 'org' && has('workorder.assign'))
      add('workorders', "SELECT COUNT(*) AS n FROM work_orders wo WHERE wo.org_id = ? AND wo.deleted_at IS NULL AND wo.status = 'CREATED' AND wo.source = 'REQUEST' AND wo.created_by <> ?", [orgId, userId]);
  }

  if (scope === 'contractor' && has('quotes.view') && has('quotes.submit'))
    add('rfqs', "SELECT COUNT(*) AS n FROM rfq_invitations i JOIN contractors c ON c.id = i.contractor_id AND c.org_id = i.org_id JOIN rfqs rq ON rq.id = i.rfq_id AND rq.org_id = i.org_id WHERE i.org_id = ? AND c.portal_user_id = ? AND i.status <> 'DECLINED' AND rq.status = 'OPEN' AND rq.released_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.rfq_id = rq.id AND q.contractor_id = c.id AND q.org_id = i.org_id AND q.status IN ('SUBMITTED','SELECTED'))", [orgId, userId]);
  else if (scope === 'org' && has('rfq.view')) {
    const conditions: string[] = [];
    const args: Array<string | number> = [orgId];
    if (has('rfq.submit')) {
      conditions.push("(rq.status = 'OPEN' AND rq.submitted_at IS NULL AND rq.created_by = ?)");
      args.push(userId);
    }
    if (has('rfq.release')) {
      conditions.push("(rq.status = 'OPEN' AND rq.submitted_at IS NOT NULL AND rq.released_at IS NULL AND rq.submitted_by <> ?)");
      args.push(userId);
    }
    if (has('rfq.award') || has('quotes.select'))
      conditions.push("(rq.status = 'OPEN' AND rq.released_at IS NOT NULL AND EXISTS (SELECT 1 FROM quotes q WHERE q.rfq_id = rq.id AND q.org_id = rq.org_id AND q.status IN ('SUBMITTED','SELECTED')))");
    if (conditions.length)
      add('rfqs', 'SELECT COUNT(*) AS n FROM rfqs rq WHERE rq.org_id = ? AND (' + conditions.join(' OR ') + ')', args);
  }

  if (scope === 'org' && has('pm.view')) {
    const conditions: string[] = [];
    const args: Array<string | number> = [orgId];
    if (has('pm.activate')) {
      conditions.push("(p.status = 'PAUSED' AND p.activated_at IS NULL AND p.created_by <> ?)");
      args.push(userId);
    }
    if (conditions.length)
      add('maintenance', 'SELECT COUNT(*) AS n FROM pm_schedules p WHERE p.org_id = ? AND (' + conditions.join(' OR ') + ')', args);
    if (has('pm.allocate'))
      add('maintenance', "SELECT COUNT(*) AS n FROM pm_occurrences o WHERE o.org_id = ? AND o.due_date <= ? AND o.status IN ('SCHEDULED','NOTIFIED_1M','NOTIFIED_2W')", [orgId, today]);
  }

  if (scope === 'org' && has('lpo.view')) {
    const conditions: string[] = [];
    const args: Array<string | number> = [orgId];
    if (has('lpo.submit')) {
      conditions.push("(l.status = 'OPEN' AND l.submitted_at IS NULL AND l.created_by = ? AND EXISTS (SELECT 1 FROM work_orders wo WHERE wo.lpo_id = l.id AND wo.org_id = l.org_id AND wo.deleted_at IS NULL))");
      args.push(userId);
    }
    if (has('lpo.approve')) {
      conditions.push("(l.status = 'OPEN' AND l.submitted_at IS NOT NULL AND l.approved_at IS NULL AND COALESCE(l.submitted_by,l.created_by) <> ?)");
      args.push(userId);
    }
    if (has('lpo.issue')) conditions.push("(l.status = 'OPEN' AND l.approved_at IS NOT NULL AND l.issued_at IS NULL)");
    if (conditions.length)
      add('lpos', 'SELECT COUNT(*) AS n FROM lpos l WHERE l.org_id = ? AND (' + conditions.join(' OR ') + ')', args);
  }

  if (scope === 'station' && has('workorder.view') && (has('arrival.confirm') || has('jobcard.confirm')))
    add('stationConfirmations', "SELECT COUNT(*) AS n FROM work_orders wo JOIN stations s ON s.id = wo.station_id AND s.org_id = wo.org_id WHERE wo.org_id = ? AND wo.deleted_at IS NULL AND s.station_manager_id = ? AND ((wo.status = 'TECH_ACCEPTED' AND ? = 1) OR (wo.status = 'WORK_DONE_PENDING_CONFIRM' AND ? = 1))", [orgId, userId, Number(has('arrival.confirm')), Number(has('jobcard.confirm'))]);

  if (scope === 'org' && has('rfq.award'))
    add('procurementApprovals', "SELECT COUNT(*) AS n FROM rfqs rq WHERE rq.org_id = ? AND rq.status = 'SENT_TO_PROCUREMENT' AND (rq.created_by <> ? OR ? = 1)", [orgId, userId, Number(actor.roles.includes('OWNER') || actor.roles.includes('ADMIN'))]);

  if (scope === 'org' && has('cost.approve')) {
    add('mileageApprovals', "SELECT COUNT(*) AS n FROM mileage_claims WHERE org_id = ? AND status = 'SUBMITTED'");
    add('costApprovals', "SELECT COUNT(*) AS n FROM work_costs WHERE org_id = ? AND status IN ('PENDING_L1','PENDING_L2')");
  }

  if (scope === 'org' && (has('bill.approve.engineering') || has('bill.approve.finance'))) {
    const statuses: string[] = [];
    if (has('bill.approve.engineering')) statuses.push("'PENDING_L1_ENG'", "'PENDING_L2_ENG_MGR'");
    if (has('bill.approve.finance')) statuses.push("'PENDING_L3_FC'");
    add('billApprovals', 'SELECT COUNT(*) AS n FROM bills WHERE org_id = ? AND status IN (' + statuses.join(',') + ')');
  }

  if (scope === 'contractor') {
    if (has('cost.view') && has('cost.submit'))
      add('costs', "SELECT COUNT(*) AS n FROM work_costs wc JOIN contractors c ON c.id = wc.contractor_id AND c.org_id = wc.org_id WHERE wc.org_id = ? AND c.portal_user_id = ? AND wc.status IN ('DRAFT','RECALLED')", [orgId, userId]);
    if (has('cost.view') && has('cost.create'))
      add('costs', "SELECT COUNT(*) AS n FROM work_orders wo JOIN contractors c ON c.id = wo.contractor_id AND c.org_id = wo.org_id WHERE wo.org_id = ? AND wo.deleted_at IS NULL AND wo.status = 'CLOSED' AND c.portal_user_id = ? AND NOT EXISTS (SELECT 1 FROM work_costs wc WHERE wc.work_order_id = wo.id AND wc.org_id = wo.org_id AND wc.status <> 'REJECTED')", [orgId, userId]);
    if (has('bill.view') && has('bill.submit'))
      add('bills', "SELECT COUNT(*) AS n FROM bills b JOIN contractors c ON c.id = b.contractor_id AND c.org_id = b.org_id WHERE b.org_id = ? AND c.portal_user_id = ? AND b.status = 'DRAFT'", [orgId, userId]);
  }

  if (scope === 'org' && has('payment.record'))
    add('payments', "SELECT COUNT(*) AS n FROM bills b WHERE b.org_id = ? AND b.status = 'APPROVED_READY_FOR_PAYMENT' AND b.total_minor > (SELECT COALESCE(SUM(p.amount_minor),0) FROM payments p WHERE p.org_id = b.org_id AND p.bill_id = b.id AND p.status <> 'REVERSED') AND NOT EXISTS (SELECT 1 FROM bill_approvals a WHERE a.org_id = b.org_id AND a.bill_id = b.id AND a.level = 3 AND a.decision = 'APPROVED' AND a.approver_id = ?)", [orgId, userId]);

  // Transfer counts represent the next action, not an unread notification.
  if (has('assets.transfer.request') || has('assets.transfer.approve') ||
      has('assets.transfer.dispatch') || has('assets.transfer.receive')) {
    const clauses: string[] = [];
    const args: Array<string | number> = [orgId];
    if (scope === 'org') {
      if (has('assets.transfer.approve')) {
        clauses.push("(tr.status = 'REQUESTED' AND tr.requested_by <> ?)");
        args.push(userId);
      }
      if (has('assets.transfer.dispatch')) clauses.push("tr.status = 'APPROVED'");
      if (has('assets.transfer.receive')) {
        clauses.push("(tr.status = 'DISPATCHED' AND tr.dispatched_by <> ?)");
        args.push(userId);
      }
    } else if (scope === 'station') {
      if (has('assets.transfer.dispatch')) {
        clauses.push("(tr.status = 'APPROVED' AND fs.station_manager_id = ?)");
        args.push(userId);
      }
      if (has('assets.transfer.receive')) {
        clauses.push("(tr.status = 'DISPATCHED' AND ts.station_manager_id = ? AND tr.dispatched_by <> ?)");
        args.push(userId, userId);
      }
    }
    if (clauses.length)
      add('assetTransfers', `SELECT COUNT(*) AS n FROM asset_transfers tr
        JOIN stations fs ON fs.id = tr.from_station_id AND fs.org_id = tr.org_id
        JOIN stations ts ON ts.id = tr.to_station_id AND ts.org_id = tr.org_id
        WHERE tr.org_id = ? AND (${clauses.join(' OR ')})`, args);
  }

  return statements;
}

/** Run one batched, read-only request. Multiple independent PM states add up. */
export async function getPendingNavigationCounts(
  db: Client,
  actor: PendingNavActor,
  today: string,
): Promise<PendingNavCounts> {
  const plan = pendingNavigationPlan(actor, today);
  if (!plan.length) return {};
  const results = await db.batch(plan.map(({ sql, args }) => ({ sql, args })), 'read');
  const counts: PendingNavCounts = {};
  for (let i = 0; i < plan.length; i++) {
    const n = Number(results[i]?.rows[0]?.n ?? 0);
    if (Number.isSafeInteger(n) && n > 0) counts[plan[i].key] = (counts[plan[i].key] ?? 0) + n;
  }
  return counts;
}
