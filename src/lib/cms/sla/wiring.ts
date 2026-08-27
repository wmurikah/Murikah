/**
 * Where domain events become SLA instances.
 *
 * Instances are created from events, never from a scan of application
 * tables. Phase 14 emits the case events, phase 11 and 13 the lead events,
 * and the workflow endpoints call the two stage functions below; this module
 * turns each into the matching start, stop, pause or resume, idempotently,
 * with the repeat key living in `startSla` (one non-cancelled instance per
 * rule and entity lifecycle).
 *
 * THE PAUSE POLICY, CENTRAL AND EXPLICIT.
 * WAITING_CUSTOMER pauses, where the rule allows pausing: the clock belongs
 * to the customer while Hass waits on them. WAITING_INTERNAL does not pause,
 * deliberately: internal waiting is precisely the thing the organisation
 * wants measured, and the rule's own `pause_allowed` flag decides whether
 * even customer waits stop the clock. CASE_PAUSE_POLICY below is that whole
 * decision; nothing else maps a status to a pause.
 *
 * Every handler begins with a sweep, so warnings and breaches that came due
 * while nothing was running are settled on the next entry into the engine.
 */
import type { Client } from '@libsql/client/web';
import { onCaseEvent, onLeadEvent, type CaseEvent, type LeadEvent } from '../service/events.ts';
import {
  resolveSlaRule,
  startSla,
  stopSla,
  pauseSla,
  resumeSla,
  sweepDueSlas,
  fromDb,
} from './engine.ts';

const text = (v: unknown): string => String(v ?? '');
const nullableText = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

/** Status → pause decision. The single mapping. */
export const CASE_PAUSE_POLICY: Readonly<Record<string, 'pause' | 'run'>> = {
  NEW: 'run',
  ASSIGNED: 'run',
  IN_PROGRESS: 'run',
  WAITING_CUSTOMER: 'pause',
  // Internal waiting is measured, not excused.
  WAITING_INTERNAL: 'run',
  RESOLVED: 'run',
  CLOSED: 'run',
  CANCELLED: 'run',
};

/** The stage codes the seeded rules use. Named once. */
export const SLA_STAGE = {
  leadFirstContact: 'FIRST_CONTACT',
  caseFirstResponse: 'FIRST_RESPONSE',
  caseResolution: 'RESOLUTION',
} as const;

interface CaseFacts {
  accountId: string;
  segment: string | null;
  affiliateId: string | null;
  priority: string;
  assignedUserId: string | null;
  assignedTeamId: string | null;
  status: string;
  raisedAt: string;
}

async function caseFacts(db: Client, caseId: string): Promise<CaseFacts | null> {
  const result = await db.execute({
    sql: `SELECT sc.account_id, a.segment, a.affiliate_id, sc.priority, sc.assigned_user_id,
                 sc.assigned_team_id, sc.status, sc.raised_at
          FROM service_cases sc JOIN accounts a ON a.account_id = sc.account_id
          WHERE sc.case_id = ? LIMIT 1`,
    args: [caseId],
  });
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    accountId: text(row.account_id),
    segment: nullableText(row.segment),
    affiliateId: nullableText(row.affiliate_id),
    priority: text(row.priority),
    assignedUserId: nullableText(row.assigned_user_id),
    assignedTeamId: nullableText(row.assigned_team_id),
    status: text(row.status),
    raisedAt: text(row.raised_at),
  };
}

async function startCaseSla(
  db: Client,
  caseId: string,
  stageCode: string,
  at: Date,
  actorUserId: string,
): Promise<void> {
  const facts = await caseFacts(db, caseId);
  if (facts === null) return;
  const rule = await resolveSlaRule(db, {
    entityType: 'CASE',
    entityId: caseId,
    accountId: facts.accountId,
    segment: facts.segment,
    affiliateId: facts.affiliateId,
    priority: facts.priority,
    stageCode,
    at,
  });
  // No matching rule: no timer is invented, nothing is created.
  if (rule === null) return;
  await startSla(db, {
    rule,
    entityType: 'CASE',
    entityId: caseId,
    workflowStageInstanceId: null,
    accountableUserId: facts.assignedUserId,
    accountableTeamId: facts.assignedTeamId,
    // The clock starts when the customer raised it, not when it was typed in.
    startedAt: fromDb(facts.raisedAt),
    actorUserId,
  });
}

async function handleCaseEvent(db: Client, event: CaseEvent): Promise<void> {
  await sweepDueSlas(db, event.at);
  switch (event.type) {
    case 'CASE_CREATED': {
      await startCaseSla(
        db,
        event.caseId,
        SLA_STAGE.caseFirstResponse,
        event.at,
        event.actorUserId,
      );
      await startCaseSla(db, event.caseId, SLA_STAGE.caseResolution, event.at, event.actorUserId);
      return;
    }
    case 'CASE_FIRST_RESPONSE': {
      await stopSla(
        db,
        { entityType: 'CASE', entityId: event.caseId, stageCode: SLA_STAGE.caseFirstResponse },
        event.detail.at !== null && event.detail.at !== undefined
          ? fromDb(event.detail.at)
          : event.at,
        'First qualifying outbound response recorded',
        event.actorUserId,
      );
      return;
    }
    case 'CASE_RESOLVED': {
      await stopSla(
        db,
        { entityType: 'CASE', entityId: event.caseId, stageCode: SLA_STAGE.caseResolution },
        event.at,
        'Case resolved',
        event.actorUserId,
      );
      return;
    }
    case 'CASE_STATUS_CHANGED': {
      const to = event.detail.toStatus ?? '';
      const from = event.detail.fromStatus ?? '';
      const wasPaused = CASE_PAUSE_POLICY[from] === 'pause';
      const nowPaused = CASE_PAUSE_POLICY[to] === 'pause';
      if (nowPaused === wasPaused) return;
      const instances = await db.execute({
        sql: `SELECT sla_instance_id FROM sla_instances
              WHERE entity_type = 'CASE' AND entity_id = ? AND status IN ('RUNNING','PAUSED')`,
        args: [event.caseId],
      });
      for (const raw of instances.rows) {
        const instanceId = String((raw as Record<string, unknown>).sla_instance_id);
        if (nowPaused) {
          // pauseSla itself refuses where the rule forbids pausing.
          await pauseSla(db, instanceId, `Case moved to ${to}`, event.at, event.actorUserId);
        } else {
          await resumeSla(db, instanceId, `Case left ${from}`, event.at, event.actorUserId);
        }
      }
      return;
    }
    case 'CASE_ASSIGNED': {
      // Accountability follows the current assignment; the histories keep the
      // past, so later analysis attributes each period correctly.
      await db.execute({
        sql: `UPDATE sla_instances SET accountable_user_id = ?, accountable_team_id = ?
              WHERE entity_type = 'CASE' AND entity_id = ? AND status IN ('RUNNING','PAUSED')`,
        args: [
          event.detail.toUserId ?? null,
          event.detail.toTeamId ?? null,
          event.caseId,
        ] as never[],
      });
      // Phase 16: tell the assignee, once per (person, case), by number only.
      const assignee = event.detail.toUserId ?? null;
      if (assignee !== null) {
        const found = await db.execute({
          sql: `SELECT case_number FROM service_cases WHERE case_id = ? LIMIT 1`,
          args: [event.caseId],
        });
        const caseNumber = found.rows[0]?.case_number;
        if (caseNumber !== undefined && caseNumber !== null) {
          const { notifyCaseAssignment } = await import('../notify/notifications.ts');
          await notifyCaseAssignment(db, {
            userId: assignee,
            caseNumber: String(caseNumber),
            caseId: event.caseId,
            at: event.at,
          });
        }
      }
      return;
    }
    case 'CASE_CLOSED':
      return;
  }
}

async function handleLeadEvent(db: Client, event: LeadEvent): Promise<void> {
  await sweepDueSlas(db, event.at);
  if (event.type === 'LEAD_CREATED') {
    const result = await db.execute({
      sql: `SELECT l.owner_user_id, l.captured_at, l.account_id, a.segment, a.affiliate_id
            FROM leads l LEFT JOIN accounts a ON a.account_id = l.account_id
            WHERE l.lead_id = ? LIMIT 1`,
      args: [event.leadId],
    });
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return;
    const rule = await resolveSlaRule(db, {
      entityType: 'LEAD',
      entityId: event.leadId,
      accountId: nullableText(row.account_id),
      segment: nullableText(row.segment),
      affiliateId: nullableText(row.affiliate_id),
      priority: null,
      stageCode: SLA_STAGE.leadFirstContact,
      at: event.at,
    });
    if (rule === null) return;
    await startSla(db, {
      rule,
      entityType: 'LEAD',
      entityId: event.leadId,
      workflowStageInstanceId: null,
      accountableUserId: text(row.owner_user_id),
      accountableTeamId: null,
      startedAt: fromDb(text(row.captured_at)),
      actorUserId: event.actorUserId,
    });
    return;
  }
  if (event.type === 'LEAD_CONTACTED') {
    await stopSla(
      db,
      { entityType: 'LEAD', entityId: event.leadId, stageCode: SLA_STAGE.leadFirstContact },
      event.detail.at !== null && event.detail.at !== undefined
        ? fromDb(event.detail.at)
        : event.at,
      'First qualifying contact recorded',
      event.actorUserId,
    );
  }
}

// ---- Workflow stage SLAs, called from the workflow endpoints ----------------

/**
 * Start the stage SLA for a workflow stage instance that just became
 * actionable. Keyed on the BUSINESS entity plus the stage code, matching the
 * seeded rules (a sales order's finance approval is a SALES_ORDER rule with
 * stage FINANCE_APPROVAL), with the stage instance referenced for
 * accountability.
 */
export async function startWorkflowStageSla(
  db: Client,
  input: {
    entityType: 'SALES_ORDER' | 'PURCHASE_ORDER';
    entityId: string;
    stageCode: string;
    stageInstanceId: string;
    accountableUserId: string | null;
    accountableTeamId: string | null;
    affiliateId: string | null;
    at: Date;
    actorUserId: string | null;
  },
): Promise<void> {
  await sweepDueSlas(db, input.at);
  const rule = await resolveSlaRule(db, {
    entityType: input.entityType,
    entityId: input.entityId,
    accountId: null,
    segment: null,
    affiliateId: input.affiliateId,
    priority: null,
    stageCode: input.stageCode,
    at: input.at,
  });
  if (rule === null) return;
  await startSla(db, {
    rule,
    entityType: input.entityType,
    entityId: input.entityId,
    workflowStageInstanceId: input.stageInstanceId,
    accountableUserId: input.accountableUserId,
    accountableTeamId: input.accountableTeamId,
    startedAt: input.at,
    actorUserId: input.actorUserId,
  });
}

/** Stop the stage SLA when its stage completes. */
export async function stopWorkflowStageSla(
  db: Client,
  input: {
    entityType: 'SALES_ORDER' | 'PURCHASE_ORDER';
    entityId: string;
    stageCode: string;
    at: Date;
    actorUserId: string | null;
  },
): Promise<void> {
  await sweepDueSlas(db, input.at);
  await stopSla(
    db,
    { entityType: input.entityType, entityId: input.entityId, stageCode: input.stageCode },
    input.at,
    'Workflow stage completed',
    input.actorUserId,
  );
}

let registered = false;

/** Called once through the events module's lazy import. */
export function registerSlaHandlers(): void {
  if (registered) return;
  registered = true;
  onCaseEvent(handleCaseEvent);
  onLeadEvent(handleLeadEvent);
}

/** Test seam. */
export function resetSlaRegistration(): void {
  registered = false;
}
