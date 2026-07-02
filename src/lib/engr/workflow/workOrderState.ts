/**
 * Work-order state machine: the only place that changes work_orders.status.
 *
 * Routes call applyTransition(); no route or repository updates the status
 * directly. Each transition is declared with its from and to status, the gating
 * permission, the ownership rule, and the timestamp column to stamp. Enforcement:
 *
 *  - permission or ownership is checked before any write,
 *  - the UPDATE carries an optimistic-concurrency guard (WHERE ... AND status =
 *    the exact status we read), so a second concurrent attempt is a no-op that
 *    returns a conflict,
 *  - every successful transition writes an audit_logs row and enqueues its
 *    notification, all inside one transaction.
 *
 * Two gates differ from Build Prompt 2's text to match the seeded roles:
 *  - assign_technician is gated on technicians.manage (what the seeded CONTRACTOR
 *    role holds) rather than workorder.assign (which it does not).
 *  - confirm_closure and reopen are gated on jobcard.confirm with station-manager
 *    ownership; the seeded STATION_MANAGER role does not hold workorder.close, and
 *    station-manager ownership is the intended route to confirm closure.
 */
import type { Client } from '@libsql/client/web';
import { enqueue } from '../notify';
import { eatDateString, nextDueDate, type PmFrequency } from '../time';

export const WO_STATUS = {
  CREATED: 'CREATED',
  CONTRACTOR_NOTIFIED: 'CONTRACTOR_NOTIFIED',
  CONTRACTOR_ACCEPTED: 'CONTRACTOR_ACCEPTED',
  CONTRACTOR_REJECTED: 'CONTRACTOR_REJECTED',
  TECH_ASSIGNED: 'TECH_ASSIGNED',
  TECH_ACCEPTED: 'TECH_ACCEPTED',
  TECH_REJECTED: 'TECH_REJECTED',
  TECH_ONSITE: 'TECH_ONSITE',
  IN_PROGRESS: 'IN_PROGRESS',
  WORK_DONE_PENDING_CONFIRM: 'WORK_DONE_PENDING_CONFIRM',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
} as const;
export type WoStatus = (typeof WO_STATUS)[keyof typeof WO_STATUS];

export const WO_ACTION = {
  contractor_accept: 'contractor_accept',
  contractor_reject: 'contractor_reject',
  assign_technician: 'assign_technician',
  technician_accept: 'technician_accept',
  technician_reject: 'technician_reject',
  submit_jsa_request_arrival: 'submit_jsa_request_arrival',
  confirm_arrival: 'confirm_arrival',
  start_work: 'start_work',
  submit_jobcard_request_closure: 'submit_jobcard_request_closure',
  confirm_closure: 'confirm_closure',
  reopen: 'reopen',
  cancel: 'cancel',
} as const;
export type WoAction = (typeof WO_ACTION)[keyof typeof WO_ACTION];

const NON_TERMINAL: WoStatus[] = [
  WO_STATUS.CREATED,
  WO_STATUS.CONTRACTOR_NOTIFIED,
  WO_STATUS.CONTRACTOR_ACCEPTED,
  WO_STATUS.CONTRACTOR_REJECTED,
  WO_STATUS.TECH_ASSIGNED,
  WO_STATUS.TECH_ACCEPTED,
  WO_STATUS.TECH_REJECTED,
  WO_STATUS.TECH_ONSITE,
  WO_STATUS.IN_PROGRESS,
  WO_STATUS.WORK_DONE_PENDING_CONFIRM,
];

interface Spec {
  from: WoStatus[];
  to: WoStatus;
  permission: string;
  ownership: 'technician' | 'station' | null;
}

const TRANSITIONS: Record<WoAction, Spec> = {
  contractor_accept: {
    from: [WO_STATUS.CONTRACTOR_NOTIFIED],
    to: WO_STATUS.CONTRACTOR_ACCEPTED,
    permission: 'workorder.accept',
    ownership: null,
  },
  contractor_reject: {
    from: [WO_STATUS.CONTRACTOR_NOTIFIED],
    to: WO_STATUS.CONTRACTOR_REJECTED,
    permission: 'workorder.accept',
    ownership: null,
  },
  assign_technician: {
    from: [WO_STATUS.CONTRACTOR_ACCEPTED],
    to: WO_STATUS.TECH_ASSIGNED,
    permission: 'technicians.manage',
    ownership: null,
  },
  technician_accept: {
    from: [WO_STATUS.TECH_ASSIGNED],
    to: WO_STATUS.TECH_ACCEPTED,
    permission: 'workorder.view',
    ownership: 'technician',
  },
  technician_reject: {
    from: [WO_STATUS.TECH_ASSIGNED],
    to: WO_STATUS.CONTRACTOR_ACCEPTED,
    permission: 'workorder.view',
    ownership: 'technician',
  },
  submit_jsa_request_arrival: {
    from: [WO_STATUS.TECH_ACCEPTED],
    to: WO_STATUS.TECH_ACCEPTED,
    permission: 'jsa.submit',
    ownership: 'technician',
  },
  confirm_arrival: {
    from: [WO_STATUS.TECH_ACCEPTED],
    to: WO_STATUS.TECH_ONSITE,
    permission: 'arrival.confirm',
    ownership: 'station',
  },
  start_work: {
    from: [WO_STATUS.TECH_ONSITE],
    to: WO_STATUS.IN_PROGRESS,
    permission: 'workorder.view',
    ownership: 'technician',
  },
  submit_jobcard_request_closure: {
    from: [WO_STATUS.TECH_ONSITE, WO_STATUS.IN_PROGRESS],
    to: WO_STATUS.WORK_DONE_PENDING_CONFIRM,
    permission: 'jobcard.submit',
    ownership: 'technician',
  },
  confirm_closure: {
    from: [WO_STATUS.WORK_DONE_PENDING_CONFIRM],
    to: WO_STATUS.CLOSED,
    permission: 'jobcard.confirm',
    ownership: 'station',
  },
  reopen: {
    from: [WO_STATUS.WORK_DONE_PENDING_CONFIRM],
    to: WO_STATUS.IN_PROGRESS,
    permission: 'jobcard.confirm',
    ownership: 'station',
  },
  cancel: {
    from: NON_TERMINAL,
    to: WO_STATUS.CANCELLED,
    permission: 'workorder.close',
    ownership: null,
  },
};

export interface WorkflowCtx {
  orgId: string;
  userId: string;
  perms: string[];
}

export interface TransitionPayload {
  reason?: string;
  technicianId?: string;
  jsaContent?: unknown;
  jobCard?: { diagnosis?: string; rootCause?: string; repairDone?: string };
  spares?: Array<{ rateItemId?: string | null; description: string; qty: number }>;
}

export type TransitionResult =
  | { ok: true; status: WoStatus }
  | { ok: false; code: 'not_found' | 'forbidden' | 'conflict' | 'invalid'; message: string };

interface WoCore {
  id: string;
  orgId: string;
  woNo: string;
  status: WoStatus;
  stationId: string;
  stationManagerId: string | null;
  contractorId: string | null;
  technicianId: string | null;
  technicianPortalUserId: string | null;
  requestId: string | null;
  pmOccurrenceId: string | null;
  createdBy: string;
}

/** Fields the ownership rules read; also used by availableActions for the UI. */
export interface WoAuthzFields {
  stationManagerId: string | null;
  technicianPortalUserId: string | null;
}

function isAuthorised(spec: Spec, ctx: WorkflowCtx, wo: WoAuthzFields): boolean {
  if (spec.ownership === 'technician') {
    return ctx.perms.includes(spec.permission) && wo.technicianPortalUserId === ctx.userId;
  }
  if (spec.ownership === 'station') {
    const isManager = wo.stationManagerId !== null && wo.stationManagerId === ctx.userId;
    return isManager || ctx.perms.includes(spec.permission);
  }
  return ctx.perms.includes(spec.permission);
}

/** The transitions the viewer may perform from the work order's current status. */
export function availableActions(
  ctx: WorkflowCtx,
  wo: WoAuthzFields & { status: WoStatus },
): WoAction[] {
  return (Object.keys(TRANSITIONS) as WoAction[]).filter((action) => {
    const spec = TRANSITIONS[action];
    return spec.from.includes(wo.status) && isAuthorised(spec, ctx, wo);
  });
}

async function loadCore(db: Client, orgId: string, id: string): Promise<WoCore | null> {
  const res = await db.execute({
    sql: `SELECT wo.id, wo.org_id, wo.wo_no, wo.status, wo.station_id, wo.contractor_id, wo.technician_id,
                 wo.request_id, wo.pm_occurrence_id, wo.created_by,
                 s.station_manager_id AS station_manager_id,
                 t.portal_user_id AS technician_portal_user_id
            FROM work_orders wo
            JOIN stations s ON s.id = wo.station_id
       LEFT JOIN technicians t ON t.id = wo.technician_id
           WHERE wo.id = ? AND wo.org_id = ? AND wo.deleted_at IS NULL
           LIMIT 1`,
    args: [id, orgId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    woNo: String(row.wo_no),
    status: String(row.status) as WoStatus,
    stationId: String(row.station_id),
    stationManagerId: row.station_manager_id === null ? null : String(row.station_manager_id),
    contractorId: row.contractor_id === null ? null : String(row.contractor_id),
    technicianId: row.technician_id === null ? null : String(row.technician_id),
    technicianPortalUserId:
      row.technician_portal_user_id === null ? null : String(row.technician_portal_user_id),
    requestId: row.request_id === null ? null : String(row.request_id),
    pmOccurrenceId: row.pm_occurrence_id === null ? null : String(row.pm_occurrence_id),
    createdBy: String(row.created_by),
  };
}

const newId = (): string => crypto.randomUUID().replace(/-/g, '');

export async function applyTransition(
  db: Client,
  ctx: WorkflowCtx,
  workOrderId: string,
  action: WoAction,
  payload: TransitionPayload = {},
): Promise<TransitionResult> {
  const spec = TRANSITIONS[action];
  const core = await loadCore(db, ctx.orgId, workOrderId);
  if (!core) return { ok: false, code: 'not_found', message: 'Work order not found.' };

  if (!isAuthorised(spec, ctx, core)) {
    return { ok: false, code: 'forbidden', message: 'You cannot perform this action.' };
  }
  if (!spec.from.includes(core.status)) {
    return {
      ok: false,
      code: 'conflict',
      message: `This action is not available while the work order is ${core.status}.`,
    };
  }
  if (action === 'assign_technician' && !payload.technicianId) {
    return { ok: false, code: 'invalid', message: 'A technician must be selected.' };
  }

  const now = new Date().toISOString();
  const orgId = ctx.orgId;

  const tx = await db.transaction('write');
  try {
    // 1. Guarded status update (optimistic concurrency on the status we read).
    const sets: string[] = ['status = ?'];
    const args: (string | number | null)[] = [spec.to];
    if (action === 'contractor_accept') {
      sets.push('contractor_accepted_at = ?');
      args.push(now);
    } else if (action === 'assign_technician') {
      sets.push('technician_id = ?', 'tech_assigned_at = ?');
      args.push(payload.technicianId ?? null, now);
    } else if (action === 'technician_accept') {
      sets.push('tech_accepted_at = ?');
      args.push(now);
    } else if (action === 'technician_reject') {
      sets.push('technician_id = ?', 'tech_assigned_at = ?');
      args.push(null, null);
    } else if (action === 'confirm_arrival') {
      sets.push('onsite_at = ?');
      args.push(now);
    } else if (action === 'confirm_closure') {
      sets.push('closed_at = ?');
      args.push(now);
    }
    sets.push('updated_at = ?');
    args.push(now, core.id, orgId, core.status);

    const upd = await tx.execute({
      sql: `UPDATE work_orders SET ${sets.join(', ')} WHERE id = ? AND org_id = ? AND status = ?`,
      args,
    });
    if (upd.rowsAffected === 0) {
      await tx.rollback();
      return {
        ok: false,
        code: 'conflict',
        message: 'The work order changed before this action completed.',
      };
    }

    // 2. Action-specific side effects.
    const side = await runSideEffects(tx, core, action, payload, ctx, now, orgId);
    if (!side.ok) {
      await tx.rollback();
      return side.result;
    }

    // 3. Audit.
    await tx.execute({
      sql: `INSERT INTO audit_logs (org_id, actor_user_id, action, entity_type, entity_id, before_json, after_json)
            VALUES (?, ?, ?, 'work_order', ?, ?, ?)`,
      args: [
        orgId,
        ctx.userId,
        action,
        core.id,
        JSON.stringify({ status: core.status }),
        JSON.stringify(
          payload.reason ? { status: spec.to, reason: payload.reason } : { status: spec.to },
        ),
      ],
    });

    // 4. Notifications.
    await runNotifications(tx, core, action, payload);

    await tx.commit();
    return { ok: true, status: spec.to };
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

type SideResult = { ok: true } | { ok: false; result: TransitionResult };

async function runSideEffects(
  tx: Awaited<ReturnType<Client['transaction']>>,
  core: WoCore,
  action: WoAction,
  payload: TransitionPayload,
  ctx: WorkflowCtx,
  now: string,
  orgId: string,
): Promise<SideResult> {
  switch (action) {
    case 'contractor_reject': {
      if (core.requestId) {
        await tx.execute({
          sql: `UPDATE service_requests SET status = 'ACCEPTED', updated_at = ? WHERE id = ? AND org_id = ?`,
          args: [now, core.requestId, orgId],
        });
      }
      return { ok: true };
    }
    case 'submit_jsa_request_arrival': {
      const pending = await tx.execute({
        sql: `SELECT COUNT(*) AS n FROM site_arrivals
               WHERE work_order_id = ? AND org_id = ? AND confirmation_status = 'PENDING'`,
        args: [core.id, orgId],
      });
      if (Number(pending.rows[0]?.n ?? 0) > 0) {
        return {
          ok: false,
          result: {
            ok: false,
            code: 'conflict',
            message: 'An arrival request is already pending.',
          },
        };
      }
      await tx.execute({
        sql: `INSERT INTO job_safety_analyses
                (id, org_id, work_order_id, technician_id, content_json, arrival_requested_at, submitted_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          newId(),
          orgId,
          core.id,
          core.technicianId,
          JSON.stringify(payload.jsaContent ?? {}),
          now,
          now,
        ],
      });
      await tx.execute({
        sql: `INSERT INTO site_arrivals
                (id, org_id, work_order_id, technician_id, confirmation_status)
              VALUES (?, ?, ?, ?, 'PENDING')`,
        args: [newId(), orgId, core.id, core.technicianId],
      });
      return { ok: true };
    }
    case 'confirm_arrival': {
      const arr = await tx.execute({
        sql: `UPDATE site_arrivals
                 SET confirmation_status = 'CONFIRMED', confirmed_by = ?, confirmed_at = ?,
                     arrived_at = COALESCE(arrived_at, ?)
               WHERE work_order_id = ? AND org_id = ? AND confirmation_status = 'PENDING'`,
        args: [ctx.userId, now, now, core.id, orgId],
      });
      if (arr.rowsAffected === 0) {
        return {
          ok: false,
          result: {
            ok: false,
            code: 'conflict',
            message: 'There is no pending arrival to confirm.',
          },
        };
      }
      return { ok: true };
    }
    case 'submit_jobcard_request_closure': {
      const existing = await tx.execute({
        sql: `SELECT id FROM job_cards
               WHERE work_order_id = ? AND org_id = ? AND status != 'CONFIRMED'
            ORDER BY created_at DESC LIMIT 1`,
        args: [core.id, orgId],
      });
      let jobCardId: string;
      if (existing.rows[0]) {
        jobCardId = String(existing.rows[0].id);
        await tx.execute({
          sql: `UPDATE job_cards
                   SET diagnosis = ?, root_cause = ?, repair_done = ?, technician_id = ?,
                       status = 'CLOSURE_REQUESTED', closure_requested_at = ?, updated_at = ?
                 WHERE id = ? AND org_id = ?`,
          args: [
            payload.jobCard?.diagnosis ?? null,
            payload.jobCard?.rootCause ?? null,
            payload.jobCard?.repairDone ?? null,
            core.technicianId,
            now,
            now,
            jobCardId,
            orgId,
          ],
        });
        await tx.execute({
          sql: `DELETE FROM job_card_spares WHERE job_card_id = ? AND org_id = ?`,
          args: [jobCardId, orgId],
        });
      } else {
        jobCardId = newId();
        await tx.execute({
          sql: `INSERT INTO job_cards
                  (id, org_id, work_order_id, technician_id, diagnosis, root_cause, repair_done,
                   status, closure_requested_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'CLOSURE_REQUESTED', ?)`,
          args: [
            jobCardId,
            orgId,
            core.id,
            core.technicianId,
            payload.jobCard?.diagnosis ?? null,
            payload.jobCard?.rootCause ?? null,
            payload.jobCard?.repairDone ?? null,
            now,
          ],
        });
      }
      for (const spare of payload.spares ?? []) {
        let unitRate: number | null = null;
        if (spare.rateItemId) {
          const rate = await tx.execute({
            sql: `SELECT unit_rate_minor FROM rate_items WHERE id = ? AND org_id = ? LIMIT 1`,
            args: [spare.rateItemId, orgId],
          });
          unitRate = rate.rows[0] ? Number(rate.rows[0].unit_rate_minor) : null;
        }
        await tx.execute({
          sql: `INSERT INTO job_card_spares
                  (id, org_id, job_card_id, rate_item_id, description, qty, unit_rate_minor)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            newId(),
            orgId,
            jobCardId,
            spare.rateItemId ?? null,
            spare.description,
            spare.qty,
            unitRate,
          ],
        });
      }
      return { ok: true };
    }
    case 'confirm_closure': {
      const jc = await tx.execute({
        sql: `UPDATE job_cards
                 SET status = 'CONFIRMED', resolution_confirmed = 1, closure_confirmed_by = ?,
                     closure_confirmed_at = ?, updated_at = ?
               WHERE work_order_id = ? AND org_id = ? AND status = 'CLOSURE_REQUESTED'`,
        args: [ctx.userId, now, now, core.id, orgId],
      });
      if (jc.rowsAffected === 0) {
        return {
          ok: false,
          result: {
            ok: false,
            code: 'conflict',
            message: 'There is no job card awaiting confirmation.',
          },
        };
      }
      if (core.requestId) {
        await tx.execute({
          sql: `UPDATE service_requests SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
          args: [now, now, core.requestId, orgId],
        });
      }
      // A PM work order carries a pm_occurrence_id. Closing it completes the
      // occurrence, rolls the schedule forward by its frequency, and materialises
      // the next occurrence. This is the only place PM closure is handled.
      if (core.pmOccurrenceId) {
        await tx.execute({
          sql: `UPDATE pm_occurrences SET status = 'COMPLETED', updated_at = ? WHERE id = ? AND org_id = ?`,
          args: [now, core.pmOccurrenceId, orgId],
        });
        const schedRes = await tx.execute({
          sql: `SELECT s.id, s.frequency, s.interval_days, o.due_date
                  FROM pm_occurrences o JOIN pm_schedules s ON s.id = o.pm_schedule_id
                 WHERE o.id = ? AND o.org_id = ? LIMIT 1`,
          args: [core.pmOccurrenceId, orgId],
        });
        const srow = schedRes.rows[0];
        if (srow) {
          const scheduleId = String(srow.id);
          const dueDate = String(srow.due_date);
          const frequency = String(srow.frequency) as PmFrequency;
          const intervalDays = srow.interval_days == null ? null : Number(srow.interval_days);
          const next = nextDueDate(dueDate, frequency, intervalDays);
          await tx.execute({
            sql: `UPDATE pm_schedules SET last_run_date = ?, next_due_date = ?, updated_at = ?
                   WHERE id = ? AND org_id = ?`,
            args: [eatDateString(new Date(now)), next, now, scheduleId, orgId],
          });
          const exists = await tx.execute({
            sql: `SELECT id FROM pm_occurrences WHERE org_id = ? AND pm_schedule_id = ? AND due_date = ? LIMIT 1`,
            args: [orgId, scheduleId, next],
          });
          if (!exists.rows[0]) {
            await tx.execute({
              sql: `INSERT INTO pm_occurrences (id, org_id, pm_schedule_id, due_date, status)
                    VALUES (?, ?, ?, ?, 'SCHEDULED')`,
              args: [newId(), orgId, scheduleId, next],
            });
          }
        }
      }
      return { ok: true };
    }
    case 'reopen': {
      await tx.execute({
        sql: `UPDATE job_cards SET status = 'REOPENED', updated_at = ?
               WHERE work_order_id = ? AND org_id = ? AND status = 'CLOSURE_REQUESTED'`,
        args: [now, core.id, orgId],
      });
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}

async function runNotifications(
  tx: Awaited<ReturnType<Client['transaction']>>,
  core: WoCore,
  action: WoAction,
  payload: TransitionPayload,
): Promise<void> {
  const orgId = core.orgId;
  const wo = core.woNo;
  const entity = { entityType: 'work_order', entityId: core.id };
  const notifyUser = (id: string | null, templateKey: string, subject: string, body: string) =>
    id
      ? enqueue(tx, orgId, {
          recipientType: 'user',
          recipientId: id,
          templateKey,
          subject,
          body,
          ...entity,
        })
      : Promise.resolve();
  const notifyContractor = (
    id: string | null,
    templateKey: string,
    subject: string,
    body: string,
  ) =>
    id
      ? enqueue(tx, orgId, {
          recipientType: 'contractor',
          recipientId: id,
          templateKey,
          subject,
          body,
          ...entity,
        })
      : Promise.resolve();
  const notifyTechnician = (
    id: string | null,
    templateKey: string,
    subject: string,
    body: string,
  ) =>
    id
      ? enqueue(tx, orgId, {
          recipientType: 'technician',
          recipientId: id,
          templateKey,
          subject,
          body,
          ...entity,
        })
      : Promise.resolve();

  switch (action) {
    case 'contractor_accept':
      await notifyUser(
        core.createdBy,
        'workorder.contractor_accepted',
        `Work order ${wo} accepted`,
        `The contractor accepted work order ${wo}.`,
      );
      break;
    case 'contractor_reject':
      await notifyUser(
        core.createdBy,
        'workorder.contractor_rejected',
        `Work order ${wo} rejected`,
        `The contractor rejected work order ${wo}. Reassign the request.`,
      );
      break;
    case 'assign_technician':
      await notifyTechnician(
        payload.technicianId ?? null,
        'workorder.technician_assigned',
        `You have work order ${wo}`,
        `A technician has been assigned to work order ${wo}.`,
      );
      break;
    case 'technician_accept':
      await notifyContractor(
        core.contractorId,
        'workorder.technician_accepted',
        `Technician accepted ${wo}`,
        `The technician accepted work order ${wo}.`,
      );
      break;
    case 'technician_reject':
      await notifyContractor(
        core.contractorId,
        'workorder.technician_rejected',
        `Technician declined ${wo}`,
        `The technician declined work order ${wo}. Reassign a technician.`,
      );
      break;
    case 'submit_jsa_request_arrival':
      await notifyUser(
        core.stationManagerId,
        'workorder.arrival_requested',
        `Arrival to confirm for ${wo}`,
        `A technician has requested arrival confirmation for work order ${wo}.`,
      );
      break;
    case 'confirm_arrival':
      await notifyTechnician(
        core.technicianId,
        'workorder.arrival_confirmed',
        `Arrival confirmed for ${wo}`,
        `Arrival was confirmed for work order ${wo}. You may begin work.`,
      );
      break;
    case 'submit_jobcard_request_closure':
      await notifyUser(
        core.stationManagerId,
        'workorder.closure_requested',
        `Closure to confirm for ${wo}`,
        `A technician has completed work order ${wo} and requested closure.`,
      );
      break;
    case 'confirm_closure':
      await notifyTechnician(
        core.technicianId,
        'workorder.closed',
        `Work order ${wo} closed`,
        `Work order ${wo} was confirmed and closed.`,
      );
      await notifyUser(
        core.createdBy,
        'workorder.closed',
        `Work order ${wo} closed`,
        `Work order ${wo} was confirmed and closed.`,
      );
      break;
    case 'reopen':
      await notifyTechnician(
        core.technicianId,
        'workorder.reopened',
        `Work order ${wo} reopened`,
        `Work order ${wo} was reopened. Further work is needed.`,
      );
      break;
    case 'cancel':
      await notifyContractor(
        core.contractorId,
        'workorder.cancelled',
        `Work order ${wo} cancelled`,
        `Work order ${wo} was cancelled.`,
      );
      await notifyTechnician(
        core.technicianId,
        'workorder.cancelled',
        `Work order ${wo} cancelled`,
        `Work order ${wo} was cancelled.`,
      );
      break;
    default:
      break;
  }
}
