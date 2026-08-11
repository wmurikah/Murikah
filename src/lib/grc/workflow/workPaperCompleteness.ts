/**
 * What makes a finding complete enough to submit for review (Build Prompt 59).
 * Pure and import-free, so it is unit tested directly and read by the form, the
 * save, the batch release and the detail's Submit alike.
 *
 * TWO DIFFERENT ACTS. Saving a draft and submitting one are not the same thing
 * and must not carry the same rules. A draft is work in progress: an auditor
 * halfway through a depot visit, with the observation written and the risk
 * rating still to decide, must be able to save and walk away, so a draft saves
 * with whatever is there. Submitting hands the finding to somebody else to
 * review, and a reviewer opening a finding with no recommendation and no auditor
 * on it cannot review anything. So the gate sits on submission alone.
 *
 * NAMING WHAT IS MISSING. A refusal that says "incomplete" is a refusal the
 * auditor has to solve by guessing, field by field, on a form of thirty
 * controls. Every check here yields the label of what is absent, and the callers
 * pass the whole list back, so one attempt gives the whole answer.
 *
 * The required set is deliberately the reviewable minimum rather than the whole
 * form: the audit context (area, sub-area and the period covered), the finding
 * itself (title, description, risk rating, recommendation), and the auditor
 * answerable for it. Everything else on the form is real work, but a reviewer
 * can read the finding without it.
 */

/**
 * The fields the completeness check reads, named as the parsed form input names
 * them (`repos/workPapers.ts::WorkPaperInput`), so a saved form and a stored row
 * are checked by the same rules through the same shape.
 */
export interface CompletenessSubject {
  auditAreaId?: string | null;
  subAreaId?: string | null;
  observationTitle?: string | null;
  observationDescription?: string | null;
  riskRating?: string | null;
  recommendation?: string | null;
  assignedAuditorId?: string | null;
  auditPeriodFrom?: string | null;
  auditPeriodTo?: string | null;
}

/** Whether a stored or posted value counts as filled: present and not blank. */
function filled(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

export interface RequiredField {
  /** What the auditor is told is missing, in the words the form uses. */
  label: string;
  /** Whether the subject satisfies it. */
  isFilled: (subject: CompletenessSubject) => boolean;
}

/**
 * The finding's reviewable minimum, in the order the form asks for it, so the
 * missing list reads top to bottom as the auditor scrolls.
 *
 * The audit period is one requirement and not two: a period with only one end is
 * not a period, and telling somebody their "audit period to" is missing when
 * they have filled neither is a worse answer than naming the thing itself.
 */
export const REQUIRED_FOR_SUBMISSION: readonly RequiredField[] = [
  { label: 'audit area', isFilled: (s) => filled(s.auditAreaId) },
  { label: 'sub-area', isFilled: (s) => filled(s.subAreaId) },
  {
    label: 'audit period',
    isFilled: (s) => filled(s.auditPeriodFrom) && filled(s.auditPeriodTo),
  },
  { label: 'observation title', isFilled: (s) => filled(s.observationTitle) },
  { label: 'observation description', isFilled: (s) => filled(s.observationDescription) },
  { label: 'risk rating', isFilled: (s) => filled(s.riskRating) },
  { label: 'recommendation', isFilled: (s) => filled(s.recommendation) },
  { label: 'assigned auditor', isFilled: (s) => filled(s.assignedAuditorId) },
];

/** The labels of everything a submission still needs, in form order. */
export function missingForSubmission(subject: CompletenessSubject): string[] {
  return REQUIRED_FOR_SUBMISSION.filter((f) => !f.isFilled(subject)).map((f) => f.label);
}

/** Whether the finding may be submitted for review. */
export function isCompleteForSubmission(subject: CompletenessSubject): boolean {
  return missingForSubmission(subject).length === 0;
}

/** The missing fields as a sentence: "audit area, risk rating and recommendation". */
export function listMissing(missing: readonly string[]): string {
  if (missing.length === 0) return '';
  if (missing.length === 1) return missing[0];
  return `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`;
}

/**
 * The refusal an auditor reads when they submit an unfinished finding: it names
 * everything that is missing rather than the first thing, so one attempt gives
 * the whole answer.
 *
 * Deliberately free of context, because the same refusal is read in three
 * places. The form adds that the work is safe as a draft, which is the thing the
 * auditor would otherwise fear; the batch prefixes the finding it is about,
 * because a list of refusals has to say which is which.
 */
export function incompleteMessage(missing: readonly string[]): string {
  return `Complete ${listMissing(missing)} before submitting for review.`;
}
