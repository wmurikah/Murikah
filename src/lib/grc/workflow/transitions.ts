/**
 * The data-driven workflow engine, IO half.
 *
 * Loads the workflow definition from the reference tables and hands it to the
 * pure evaluator in transitionRules.ts. `enum_values`, `status_transitions` and
 * `workflow_terminal_states` define the product's workflow and are shared across
 * organisations (reference data, not tenant data), so they are read without an
 * organisation filter; the tenant rows they govern are always org-scoped by the
 * caller. Centralised so every module validates a status change the same way.
 *
 * Column assumptions for the hassaudit schema are documented in
 * grc/docs/schema-assumptions.md and are the single place to reconcile if the
 * operator's column names differ.
 */
import type { Client } from '@libsql/client/web';
import { C, cols } from '@grc/schema/columns';
import {
  evaluateTransition,
  type TransitionRule,
  type TransitionAttempt,
  type TransitionOutcome,
} from './transitionRules';

export type { TransitionRule, TransitionAttempt, TransitionOutcome };

function bool(v: unknown): boolean {
  return v === 1 || v === true || v === '1' || v === 'true';
}

/** The allowed values for an enum type, in their configured order. */
export async function loadEnumValues(db: Client, enumType: string): Promise<string[]> {
  const ev = cols(C.enum_values);
  const res = await db.execute({
    sql: `SELECT ${ev.enum_value} AS value FROM enum_values
           WHERE ${ev.enum_type} = ? ORDER BY ${ev.display_order}, ${ev.enum_value}`,
    args: [enumType],
  });
  return res.rows.map((r) => String(r.value));
}

/** The allowed transitions for an enum type. */
export async function loadTransitions(db: Client, enumType: string): Promise<TransitionRule[]> {
  const st = cols(C.status_transitions);
  const res = await db.execute({
    sql: `SELECT ${st.from_status} AS from_status, ${st.to_status} AS to_status,
                 ${st.required_role} AS required_role, ${st.requires_comment} AS requires_comment
            FROM status_transitions WHERE ${st.enum_type} = ?`,
    args: [enumType],
  });
  return res.rows.map((r) => ({
    fromStatus: String(r.from_status),
    toStatus: String(r.to_status),
    requiredRole: r.required_role == null ? null : String(r.required_role),
    requiresComment: bool(r.requires_comment),
  }));
}

/**
 * The end states for a workflow: statuses nothing may leave. The live table keys
 * these by `workflow_name`/`terminal_status` (not the enum_type/status this once
 * assumed); the enum type name is passed as the workflow name.
 */
export async function loadTerminalStates(db: Client, enumType: string): Promise<string[]> {
  const wts = cols(C.workflow_terminal_states);
  const res = await db.execute({
    sql: `SELECT ${wts.terminal_status} AS terminal_status FROM workflow_terminal_states
           WHERE ${wts.workflow_name} = ?`,
    args: [enumType],
  });
  return res.rows.map((r) => String(r.terminal_status));
}

/**
 * Load the definition for an enum type and evaluate an attempted change against
 * it. The rules and terminal states are read fresh so a workflow edit takes
 * effect immediately; a module that changes many rows can load once and call the
 * pure evaluator itself.
 */
export async function checkTransition(
  db: Client,
  enumType: string,
  attempt: TransitionAttempt,
): Promise<TransitionOutcome> {
  const [rules, terminals] = await Promise.all([
    loadTransitions(db, enumType),
    loadTerminalStates(db, enumType),
  ]);
  return evaluateTransition(rules, terminals, attempt);
}
