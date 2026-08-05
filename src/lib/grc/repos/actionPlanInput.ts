/**
 * The action-plan form input and the priority vocabulary, pure and import-free
 * so node strips types and unit-tests this directly (the same convention as the
 * workflow catalogues). The repository re-exports these, so callers keep
 * importing from `@grc/repos/actionPlans`.
 */

/**
 * The priority vocabulary. The source treats priority as a fixed severity scale
 * on the plan itself (unlike the control fields, which are per-organisation
 * dropdowns), so it is the same everywhere and needs no config round trip.
 */
export const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'] as const;

export interface ActionPlanInput {
  workPaperId: string | null;
  actionDescription: string;
  /** The agreed remediation date, which the overdue job measures against. */
  targetDate: string | null;
  dueDate: string | null;
  priority: string | null;
  implementationNotes: string | null;
}

/**
 * Parse a submitted form into an ActionPlanInput. The target date is the agreed
 * remediation date; when only one date is given the two are kept in step, since
 * the overdue job measures against due_date and the source treats an unset
 * target as the due date. The affiliate is not on the form: a plan inherits it
 * from the finding it remediates, resolved on create.
 */
export function parseActionPlanInput(form: FormData): ActionPlanInput {
  const t = (key: string): string | null => {
    const raw = form.get(key);
    if (raw == null) return null;
    const str = String(raw).trim();
    return str === '' ? null : str;
  };
  const targetDate = t('target_date');
  const dueDate = t('due_date');
  return {
    workPaperId: t('work_paper_id'),
    actionDescription: t('action_description') ?? '',
    targetDate: targetDate ?? dueDate,
    dueDate: dueDate ?? targetDate,
    priority: t('priority'),
    implementationNotes: t('implementation_notes'),
  };
}

/**
 * Validate a parsed input. The work paper is the parent of everything: a plan
 * with no parent finding is an orphan invisible to every drill-down and to
 * observation-level reporting, so the linkage is required on create and edit
 * alike (there is deliberately no ad hoc, unlinked plan type). Returns a
 * single user-facing reason, or null when the input is acceptable.
 */
export function checkActionPlanInput(input: ActionPlanInput): string | null {
  if (!input.actionDescription) {
    return 'The action description is required.';
  }
  if (!input.workPaperId) {
    return 'Every action plan must be linked to a parent finding. Choose the work paper it remediates.';
  }
  return null;
}

/**
 * The page a mutation returns to: the submitted one when it is a safe
 * root-relative path under `prefix`, else the given fallback. A dropped Kanban
 * card sends the board it came from this way, so the guard keeps an attacker
 * from turning that field into an open redirect (protocol-relative, absolute,
 * scheme-bearing and prefix-lookalike paths are all refused).
 */
export function safeReturnPath(raw: string | null, prefix: string, fallback: string): string {
  if (!raw) return fallback;
  const path = raw.trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return fallback;
  const [base] = path.split('?');
  return base === prefix || base.startsWith(prefix + '/') ? path : fallback;
}
