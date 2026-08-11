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
 *
 * THE ENUM IS THE SCOPE, AND IT IS MATCHED FOR WHAT IT MEANS (Build Prompt 61).
 * `status_transitions` holds every workflow in the product in one table, keyed
 * by `enum_type`, and more than one of them defines a `Draft -> Submitted`: a
 * work paper's, and an auditee response's. So every read here is scoped to the
 * one enum the caller names, and the comparison is whitespace and case tolerant
 * for the same reason the status comparisons are: these are operator-managed
 * reference rows, and the live table spells the work-paper workflow
 * `work_paper_status` while the code spelled it `WORK_PAPER_STATUS`. A
 * case-sensitive `=` matched none of them, so the engine loaded an empty rule
 * set and refused every move a work paper could make, with the message that says
 * the move is not permitted. Tolerant does not mean loose: a row under another
 * enum is never a match, whatever its from and to say.
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

/**
 * The predicate that scopes a read to one workflow: this column names the same
 * enum as the bound parameter, whitespace and case aside.
 *
 * Written once and reused, so the three reference reads cannot drift into
 * matching differently, which is the whole shape of the fault it exists to
 * prevent.
 */
function sameEnum(column: string): string {
  return `TRIM(LOWER(${column})) = TRIM(LOWER(?))`;
}

/** The allowed values for an enum type, in their configured order. */
export async function loadEnumValues(db: Client, enumType: string): Promise<string[]> {
  const ev = cols(C.enum_values);
  const res = await db.execute({
    sql: `SELECT ${ev.enum_value} AS value FROM enum_values
           WHERE ${sameEnum(ev.enum_type)} ORDER BY ${ev.display_order}, ${ev.enum_value}`,
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
            FROM status_transitions WHERE ${sameEnum(st.enum_type)}`,
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
           WHERE ${sameEnum(wts.workflow_name)}`,
    args: [enumType],
  });
  return res.rows.map((r) => String(r.terminal_status));
}

/**
 * The enum types that do define a `from -> to` move (Build Prompt 61).
 *
 * Read only when a move has just been refused, and only to say so in the log: a
 * refusal whose cause is "the row is under another workflow" is invisible from
 * the outside, because the row an operator finds when they look is a real row
 * that really does say Draft to Submitted. Naming the enums that hold it, beside
 * the enum that was searched, makes that mismatch the first thing anybody sees.
 */
export async function enumTypesWithTransition(
  db: Client,
  from: string,
  to: string,
): Promise<string[]> {
  const st = cols(C.status_transitions);
  try {
    const res = await db.execute({
      sql: `SELECT DISTINCT ${st.enum_type} AS enum_type FROM status_transitions
             WHERE TRIM(LOWER(${st.from_status})) = TRIM(LOWER(?))
               AND TRIM(LOWER(${st.to_status})) = TRIM(LOWER(?))`,
      args: [from, to],
    });
    return res.rows.map((r) => String(r.enum_type));
  } catch {
    // Diagnostics must never become the reason a refusal fails to return.
    return [];
  }
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
