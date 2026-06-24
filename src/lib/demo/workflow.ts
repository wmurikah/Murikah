/**
 * Workflow demo: a constrained, declarative builder over a whitelist of blocks.
 * No visitor input is ever executed as code. The server validates the
 * definition against the whitelist, rejects anything not on it, and evaluates
 * it deterministically against a fixed sample event, returning a step-by-step
 * audit log.
 */

export interface BlockOption {
  id: string;
  label: string;
}

export const TRIGGERS: BlockOption[] = [
  { id: 'invoice_received', label: 'New invoice received' },
  { id: 'deal_won', label: 'Deal marked Won' },
  { id: 'high_risk_finding', label: 'New high-risk finding raised' },
];

export const CONDITIONS: BlockOption[] = [
  { id: 'none', label: 'No condition (always run)' },
  { id: 'amount_over', label: 'Amount is over a threshold' },
  { id: 'risk_high', label: 'Risk equals High' },
];

export const ACTIONS: BlockOption[] = [
  { id: 'notify_approver', label: 'Notify an approver' },
  { id: 'create_task', label: 'Create a follow-up task' },
  { id: 'add_board_report', label: 'Add to the board report' },
  { id: 'send_email', label: 'Send an email' },
];

/** Fixed, server-side sample events. Visitors never supply the event. */
const SAMPLE_EVENTS: Record<string, Record<string, unknown>> = {
  invoice_received: { type: 'invoice_received', amount: 120000, supplier: 'Sample Stationers Ltd' },
  deal_won: { type: 'deal_won', deal: 'Sample Fintech Ltd', value: 150000 },
  high_risk_finding: { type: 'high_risk_finding', ref: 'MK-2026-001', risk: 'High' },
};

export interface WorkflowDefinition {
  trigger: string;
  condition: { id: string; threshold?: number };
  actions: string[];
}

export interface WorkflowLogStep {
  step: string;
  detail: string;
  at: string;
}

export interface WorkflowResult {
  event: Record<string, unknown>;
  conditionMet: boolean;
  firedActions: string[];
  log: WorkflowLogStep[];
}

const ACTION_LABEL = new Map(ACTIONS.map((a) => [a.id, a.label]));

/** Strictly validate a definition against the whitelist. */
export function validateDefinition(
  input: unknown,
): { ok: true; value: WorkflowDefinition } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid workflow.' };
  const o = input as Record<string, unknown>;

  const trigger = String(o.trigger ?? '');
  if (!TRIGGERS.some((t) => t.id === trigger)) return { ok: false, error: 'Unknown trigger.' };

  const cond = (o.condition ?? {}) as Record<string, unknown>;
  const conditionId = String(cond.id ?? 'none');
  if (!CONDITIONS.some((c) => c.id === conditionId))
    return { ok: false, error: 'Unknown condition.' };

  const rawActions = Array.isArray(o.actions) ? o.actions.map(String) : [];
  if (rawActions.length === 0) return { ok: false, error: 'Choose at least one action.' };
  if (rawActions.some((a) => !ACTION_LABEL.has(a))) return { ok: false, error: 'Unknown action.' };

  const threshold =
    conditionId === 'amount_over' ? Math.max(0, Number(cond.threshold) || 0) : undefined;

  return {
    ok: true,
    value: { trigger, condition: { id: conditionId, threshold }, actions: rawActions.slice(0, 8) },
  };
}

/** Evaluate a validated definition deterministically. `now` is the request time. */
export function evaluateWorkflow(def: WorkflowDefinition, now: Date): WorkflowResult {
  const event = SAMPLE_EVENTS[def.trigger] ?? {};
  const log: WorkflowLogStep[] = [];
  const stamp = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

  log.push({
    step: 'Trigger',
    detail: `${triggerLabel(def.trigger)} fired with a sample event.`,
    at: stamp(0),
  });

  let conditionMet = true;
  if (def.condition.id === 'amount_over') {
    const amount = Number(event.amount ?? 0);
    conditionMet = amount > (def.condition.threshold ?? 0);
    log.push({
      step: 'Condition',
      detail: `Amount ${amount} is ${conditionMet ? 'over' : 'not over'} the threshold ${def.condition.threshold ?? 0}.`,
      at: stamp(20),
    });
  } else if (def.condition.id === 'risk_high') {
    conditionMet = String(event.risk ?? '') === 'High';
    log.push({
      step: 'Condition',
      detail: `Risk is ${event.risk ?? 'not set'}; condition ${conditionMet ? 'met' : 'not met'}.`,
      at: stamp(20),
    });
  } else {
    log.push({ step: 'Condition', detail: 'No condition; proceeding.', at: stamp(20) });
  }

  const firedActions: string[] = [];
  if (conditionMet) {
    def.actions.forEach((id, i) => {
      const label = ACTION_LABEL.get(id) ?? id;
      firedActions.push(label);
      log.push({ step: 'Action', detail: `${label} (simulated).`, at: stamp(40 + i * 20) });
    });
  } else {
    log.push({ step: 'Skipped', detail: 'Condition not met, no actions fired.', at: stamp(40) });
  }

  return { event, conditionMet, firedActions, log };
}

function triggerLabel(id: string): string {
  return TRIGGERS.find((t) => t.id === id)?.label ?? id;
}
