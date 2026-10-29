/**
 * The four AI features, ported from 05_AIService.gs. Each builds its prompt,
 * routes through the unified callAI (which logs the invocation with its purpose
 * and token usage), and shapes the result. Work-paper insights and analytics
 * insights return Markdown; action-plan validation returns SMART JSON and falls
 * back to the non-AI validation when AI is disabled or unavailable; the auditee
 * evaluation returns an auto-reject decision against the threshold. Every result
 * carries the advisory disclaimer.
 */
import type { Client } from '@libsql/client/web';
import { callAI } from './service';
import {
  extractJson,
  validateSmartBasic,
  AI_DISCLAIMER,
  type ActionPlanValidation,
  type SmartInput,
} from './validation';
import {
  workPaperInsightsPrompt,
  validateActionPlanPrompt,
  evaluateResponsePrompt,
  analyticsInsightsPrompt,
  draftObservationPrompt,
  draftRecommendationPrompt,
  suggestRiskRatingPrompt,
  type WorkPaperContext,
  type ActionPlanContext,
  type ResponseContext,
  type DraftContext,
} from './prompts';

export interface InsightResult {
  ok: boolean;
  markdown: string;
  disclaimer: string;
  error?: string;
}

export async function workPaperInsights(
  db: Client,
  organizationId: string,
  userId: string,
  wp: WorkPaperContext,
  workPaperId: string,
): Promise<InsightResult> {
  const res = await callAI(
    db,
    {
      organizationId,
      userId,
      purpose: 'WORK_PAPER_INSIGHTS',
      relatedEntityType: 'work_paper',
      relatedEntityId: workPaperId,
    },
    workPaperInsightsPrompt(wp),
  );
  return { ok: res.ok, markdown: res.content, disclaimer: AI_DISCLAIMER, error: res.error };
}

export async function analyticsInsights(
  db: Client,
  organizationId: string,
  userId: string,
  portfolioSummary: string,
): Promise<InsightResult> {
  const res = await callAI(
    db,
    { organizationId, userId, purpose: 'ANALYTICS_INSIGHTS' },
    analyticsInsightsPrompt(portfolioSummary),
  );
  return { ok: res.ok, markdown: res.content, disclaimer: AI_DISCLAIMER, error: res.error };
}

export interface ValidationOutcome extends ActionPlanValidation {
  aiUsed: boolean;
  disclaimer: string;
}

interface ValidationJson {
  isValid?: boolean;
  score?: number;
  issues?: string[];
  suggestions?: string[];
  strengths?: string[];
}

export async function validateActionPlan(
  db: Client,
  organizationId: string,
  userId: string,
  ap: ActionPlanContext,
  smart: SmartInput,
  now: Date,
  actionPlanId: string | null,
): Promise<ValidationOutcome> {
  const res = await callAI(
    db,
    {
      organizationId,
      userId,
      purpose: 'VALIDATE_ACTION_PLAN',
      relatedEntityType: 'action_plan',
      relatedEntityId: actionPlanId,
    },
    validateActionPlanPrompt(ap),
  );
  if (res.ok) {
    const parsed = extractJson<ValidationJson>(res.content);
    if (parsed && typeof parsed.score === 'number' && Array.isArray(parsed.issues)) {
      return {
        isValid: parsed.isValid === true,
        score: parsed.score,
        issues: parsed.issues,
        suggestions: parsed.suggestions ?? [],
        strengths: parsed.strengths ?? [],
        aiUsed: true,
        disclaimer: AI_DISCLAIMER,
      };
    }
  }
  // AI disabled or unparseable: the non-AI SMART validation still works.
  return { ...validateSmartBasic(smart, now), aiUsed: false, disclaimer: AI_DISCLAIMER };
}

export interface EvaluationOutcome {
  autoReject: boolean;
  feedback: string;
  score: number;
  aiUsed: boolean;
  disclaimer: string;
}

interface EvaluationJson {
  autoReject?: boolean;
  score?: number;
  feedback?: string;
}

export async function evaluateAuditeeResponse(
  db: Client,
  organizationId: string,
  userId: string,
  r: ResponseContext,
  rejectionThreshold: number,
  workPaperId: string | null,
): Promise<EvaluationOutcome> {
  const res = await callAI(
    db,
    {
      organizationId,
      userId,
      purpose: 'EVALUATE_AUDITEE_RESPONSE',
      relatedEntityType: 'work_paper',
      relatedEntityId: workPaperId,
    },
    evaluateResponsePrompt(r),
  );
  if (res.ok) {
    const parsed = extractJson<EvaluationJson>(res.content);
    if (parsed && typeof parsed.score === 'number') {
      const score = parsed.score;
      return {
        autoReject: parsed.autoReject === true || score < rejectionThreshold,
        feedback: parsed.feedback ?? '',
        score,
        aiUsed: true,
        disclaimer: AI_DISCLAIMER,
      };
    }
  }
  // Without a usable AI verdict, never auto-reject; the auditor reviews as normal.
  return { autoReject: false, feedback: '', score: 0, aiUsed: false, disclaimer: AI_DISCLAIMER };
}

export type DraftKind = 'observation' | 'recommendation' | 'risk_rating';

/** A drafting kind, or null when the value did not come from the form. */
export function parseDraftKind(raw: string | null): DraftKind | null {
  if (raw === 'observation' || raw === 'recommendation' || raw === 'risk_rating') return raw;
  return null;
}

export interface DraftResult {
  ok: boolean;
  /** The draft text, or for a risk rating the rationale line. */
  content: string;
  /** The suggested rating (Critical, High, Medium or Low), risk_rating only. */
  rating?: string;
  disclaimer: string;
  error?: string;
}

const RATINGS = ['Critical', 'High', 'Medium', 'Low'];

/**
 * Drafting help for the work-paper form: a first draft of the observation
 * detail or the numbered recommendations, or a risk-rating suggestion with its
 * rationale. Advisory only: the output lands in an editable field and the
 * auditor decides what survives.
 */
export async function draftAssistance(
  db: Client,
  organizationId: string,
  userId: string,
  invokerRole: string | null,
  kind: DraftKind,
  context: DraftContext,
): Promise<DraftResult> {
  const prompt =
    kind === 'observation'
      ? draftObservationPrompt(context)
      : kind === 'recommendation'
        ? draftRecommendationPrompt(context)
        : suggestRiskRatingPrompt(context);
  const res = await callAI(
    db,
    {
      organizationId,
      userId,
      invokerRole,
      purpose: `DRAFT_${kind.toUpperCase()}`,
    },
    prompt,
  );
  if (!res.ok) {
    return { ok: false, content: '', disclaimer: AI_DISCLAIMER, error: res.error };
  }
  if (kind !== 'risk_rating') {
    return { ok: true, content: res.content.trim(), disclaimer: AI_DISCLAIMER };
  }
  // First line carries the rating; anything unrecognised is surfaced as-is so
  // the auditor still sees what came back rather than a silent failure.
  const [first = '', ...rest] = res.content.trim().split(/\r?\n/);
  const rating = RATINGS.find((r) => first.toLowerCase().includes(r.toLowerCase()));
  return {
    ok: true,
    content: rest.join(' ').trim() || first.trim(),
    rating,
    disclaimer: AI_DISCLAIMER,
  };
}
