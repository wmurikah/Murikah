/**
 * The non-AI parts of the AI assistance: the SMART action-plan validation
 * fallback (used when AI is disabled so the feature still works), a tolerant
 * JSON extractor for the AI responses that return structured data, the advisory
 * disclaimer every AI output carries, and the API-key masking. Import-free, so
 * node strips types and unit-tests this directly.
 */

/** Every AI output carries this: the guidance is advisory and must be checked. */
export const AI_DISCLAIMER =
  'This is AI-generated guidance. It is advisory only and must be checked against your professional judgement before you rely on it.';

/** Mask an API key to a short tail, for display (the key itself stays a secret). */
export function maskKey(key: string | null | undefined): string {
  if (!key || key.trim() === '') return 'Not set';
  const trimmed = key.trim();
  return trimmed.length <= 4 ? '****' : `****${trimmed.slice(-4)}`;
}

/**
 * Extract the first JSON object from an AI text response (models often wrap JSON
 * in prose or a code fence). Returns null when nothing parses.
 */
export function extractJson<T>(text: string): T | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export interface ActionPlanValidation {
  isValid: boolean;
  score: number;
  issues: string[];
  suggestions: string[];
  strengths: string[];
}

export interface SmartInput {
  description: string;
  ownerCount: number;
  dueDate: string | null;
}

// A small set of action verbs; a SMART action reads as a directive.
const ACTION_VERBS = [
  'implement',
  'establish',
  'review',
  'update',
  'develop',
  'create',
  'conduct',
  'ensure',
  'document',
  'define',
  'assign',
  'monitor',
  'remediate',
  'strengthen',
  'introduce',
  'revise',
  'enforce',
  'train',
  'automate',
  'reconcile',
  'perform',
  'complete',
];

/**
 * The basic non-AI SMART validation: specific (described in enough detail),
 * assignable (an owner), time-bound (a sensible future due date) and
 * action-oriented (an action verb), each worth a quarter of the score.
 */
export function validateSmartBasic(input: SmartInput, now: Date): ActionPlanValidation {
  const issues: string[] = [];
  const suggestions: string[] = [];
  const strengths: string[] = [];
  let score = 0;
  const desc = input.description.trim();

  if (desc.length >= 40) {
    score += 25;
    strengths.push('The action is described in enough detail to be specific.');
  } else {
    issues.push('The description is too brief to be specific.');
    suggestions.push('Describe what will be done, by whom and how.');
  }

  if (input.ownerCount > 0) {
    score += 25;
    strengths.push('An owner is assigned.');
  } else {
    issues.push('No owner is assigned.');
    suggestions.push('Assign at least one owner accountable for delivery.');
  }

  const due = input.dueDate ? Date.parse(input.dueDate) : Number.NaN;
  if (!Number.isNaN(due) && due > now.getTime()) {
    score += 25;
    strengths.push('A realistic future due date is set.');
  } else if (!Number.isNaN(due)) {
    issues.push('The due date is in the past.');
    suggestions.push('Set a realistic future due date.');
  } else {
    issues.push('No due date is set.');
    suggestions.push('Set a realistic future due date.');
  }

  const lower = desc.toLowerCase();
  if (ACTION_VERBS.some((v) => lower.includes(v))) {
    score += 25;
    strengths.push('The action uses a clear action verb.');
  } else {
    issues.push('The action does not read as a clear directive.');
    suggestions.push('Begin with a verb such as Implement, Review or Establish.');
  }

  return { isValid: score >= 75, score, issues, suggestions, strengths };
}
