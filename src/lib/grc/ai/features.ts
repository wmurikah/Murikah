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
  type WorkPaperContext,
  type ActionPlanContext,
  type ResponseContext,
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
