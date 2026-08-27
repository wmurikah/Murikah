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
