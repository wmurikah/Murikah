/**
 * Segregation of duties for the money ladders (costing and billing).
 *
 * Pure and self-contained (no imports, no bindings) so the control rules can be
 * unit tested with node:test. The ladder modules call these before recording any
 * approval or payment; the rules are enforced in code, not by permissions alone,
 * because one user can hold two adjacent approval keys.
 *
 * Rules:
 *  - The submitter may not approve any level of their own cost or bill.
 *  - No single user may approve two levels of the same cost or bill: the approver
 *    at a level must differ from every prior-level approver (which also enforces
 *    the level N differs from level N-1 rule). OWNER and ADMIN are bound by this
 *    too; there is no break-glass bypass.
 *  - The approver-versus-payer question is a single switch, defaulting to allow
 *    the level 3 financial controller who approved a bill to also record its
 *    payment. Flip it to require a different finance user without touching the
 *    flow.
 */

/**
 * Whether the financial controller who approved bill level 3 may also record the
 * payment. This is the point most likely to need a stricter rule; set it to
 * false to require a different finance user.
 */
export const ALLOW_L3_APPROVER_TO_RECORD_PAYMENT = true;

export interface ApproverCheck {
  actorId: string;
  submitterId: string | null;
  priorApproverIds: string[];
}

export interface SodResult {
  ok: boolean;
  reason: string | null;
}

/** May this actor approve, given the submitter and the prior-level approvers? */
export function checkApprover(check: ApproverCheck): SodResult {
  if (check.submitterId && check.actorId === check.submitterId) {
    return { ok: false, reason: 'The submitter cannot approve their own submission.' };
  }
  if (check.priorApproverIds.includes(check.actorId)) {
    return { ok: false, reason: 'A different approver is required at this level.' };
  }
  return { ok: true, reason: null };
}

/** May this actor record payment, given who approved level 3? */
export function checkPayer(check: { actorId: string; l3ApproverId: string | null }): SodResult {
  if (ALLOW_L3_APPROVER_TO_RECORD_PAYMENT) return { ok: true, reason: null };
  if (check.l3ApproverId && check.actorId === check.l3ApproverId) {
    return { ok: false, reason: 'A different finance user must record the payment.' };
  }
  return { ok: true, reason: null };
}
