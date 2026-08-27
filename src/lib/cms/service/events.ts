/**
 * The domain events the service and CRM modules emit, and the register phase
 * 15 subscribes to.
 *
 * Phase 15 creates and stops SLA instances FROM EVENTS, never from a scan of
 * application tables. This module is the seam: a write path calls `emit`
 * after its transaction commits, and whatever phase 15 has registered runs.
 * Today nothing is registered and `emit` is a no-op that costs one array
 * read, which is exactly what "emit clean events, implement no timer" means.
 *
 * Events are emitted AFTER the commit, not inside it. An SLA side effect
 * that failed must never roll back the business fact that a case was
 * resolved, and a business transaction must never block on one.
 */
import type { Client } from '@libsql/client/web';

export type CaseEventType =
  | 'CASE_CREATED'
  | 'CASE_ASSIGNED'
  | 'CASE_FIRST_RESPONSE'
  | 'CASE_STATUS_CHANGED'
  | 'CASE_RESOLVED'
  | 'CASE_CLOSED';

export interface CaseEvent {
  readonly type: CaseEventType;
  readonly caseId: string;
  /** The moment the event happened in the business, not when it was emitted. */
  readonly at: Date;
  readonly actorUserId: string;
  /** Event-specific facts: statuses, assignees, the communication id. */
  readonly detail: Readonly<Record<string, string | null>>;
}

export type CaseEventHandler = (db: Client, event: CaseEvent) => Promise<void>;

const handlers: CaseEventHandler[] = [];

/** Phase 15 calls this once at module load. Nothing else should. */
export function onCaseEvent(handler: CaseEventHandler): void {
  handlers.push(handler);
}

/** Test seam: forget every handler. Never called by product code. */
export function resetCaseEventHandlers(): void {
  handlers.length = 0;
}

export async function emitCaseEvent(db: Client, event: CaseEvent): Promise<void> {
  await ensureSlaWiring();
  for (const handler of handlers) {
    try {
      await handler(db, event);
    } catch (error) {
      // The business write has already committed. A failed consumer is a
      // consumer's problem to log, never a reason to un-resolve a case.
      console.error(`[cms.service.events] handler failed for ${event.type}`, error);
    }
  }
}

// ---- Lead events, the same seam for the CRM side ---------------------------

export type LeadEventType = 'LEAD_CREATED' | 'LEAD_CONTACTED';

export interface LeadEvent {
  readonly type: LeadEventType;
  readonly leadId: string;
  readonly at: Date;
  readonly actorUserId: string;
  readonly detail: Readonly<Record<string, string | null>>;
}

export type LeadEventHandler = (db: Client, event: LeadEvent) => Promise<void>;

const leadHandlers: LeadEventHandler[] = [];

export function onLeadEvent(handler: LeadEventHandler): void {
  leadHandlers.push(handler);
}

export function resetLeadEventHandlers(): void {
  leadHandlers.length = 0;
}

export async function emitLeadEvent(db: Client, event: LeadEvent): Promise<void> {
  await ensureSlaWiring();
  for (const handler of leadHandlers) {
    try {
      await handler(db, event);
    } catch (error) {
      console.error(`[cms.service.events] handler failed for ${event.type}`, error);
    }
  }
}

/**
 * The phase 15 SLA engine subscribes through this lazy import, which breaks
 * what would otherwise be a static cycle: the repositories import this
 * module to emit, and the wiring imports the repositories' tables through
 * the engine. Dynamic, once, and a wiring failure disables SLA consumption
 * without ever blocking a business write.
 */
let wired: Promise<void> | null = null;
function ensureSlaWiring(): Promise<void> {
  if (wired === null) {
    wired = import('../sla/wiring.ts')
      .then((module) => module.registerSlaHandlers())
      .catch((error) => {
        console.error('[cms.service.events] SLA wiring failed to load', error);
      });
  }
  return wired;
}

/** Test seam: allow a suite to re-register after resetting handlers. */
export function resetSlaWiring(): void {
  wired = null;
}
