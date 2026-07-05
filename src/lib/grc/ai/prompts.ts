/**
 * The prompt builders for the four AI features, ported from 05_AIService.gs. Each
 * returns the user prompt; the system prompt is the configured one (with the
 * default below). The validation and evaluation prompts ask for strict JSON so
 * the result can be parsed. Import-free, so it is unit-tested directly.
 */

export const DEFAULT_SYSTEM_PROMPT =
  'You are an internal audit assistant for a petroleum group. You give precise, ' +
  'practical, standards-aware guidance (IIA, COSO). You are advisory only and never ' +
  'replace professional judgement. Be concise and specific.';

export interface WorkPaperContext {
  reference: string;
  title: string;
  description: string;
  riskRating: string;
  recommendation: string;
  affiliate: string;
  auditArea: string;
}

export function workPaperInsightsPrompt(wp: WorkPaperContext): string {
  return [
    'Analyse this internal audit finding and respond in Markdown with these sections:',
    '1. Quality assessment of the observation.',
    '2. Risk rating validation (is the stated rating appropriate?).',
    '3. Recommendation enhancement.',
    '4. Root cause analysis.',
    '5. Best-practice tips.',
    '',
    `Reference: ${wp.reference}`,
    `Affiliate: ${wp.affiliate}`,
    `Audit area: ${wp.auditArea}`,
    `Observation: ${wp.title}`,
    `Detail: ${wp.description}`,
    `Stated risk rating: ${wp.riskRating}`,
    `Recommendation: ${wp.recommendation}`,
  ].join('\n');
}

export interface ActionPlanContext {
  description: string;
  dueDate: string;
  owners: string;
  observationTitle: string;
}

export function validateActionPlanPrompt(ap: ActionPlanContext): string {
  return [
    'Evaluate this remediation action plan against SMART criteria (Specific,',
    'Measurable, Achievable, Relevant, Time-bound). Respond with strict JSON only,',
    'no prose, in this shape:',
    '{"isValid": boolean, "score": number (0-100), "issues": string[], "suggestions": string[], "strengths": string[]}',
    '',
    `Observation: ${ap.observationTitle}`,
    `Action: ${ap.description}`,
    `Owners: ${ap.owners}`,
    `Due date: ${ap.dueDate}`,
  ].join('\n');
}

export interface ResponseContext {
  observation: string;
  recommendation: string;
  response: string;
  plans: string;
}

export function evaluateResponsePrompt(r: ResponseContext): string {
  return [
    'Evaluate this auditee management response and its proposed action plans against',
    'the observation and recommendation. Judge whether the response adequately',
    'addresses the finding. Respond with strict JSON only, no prose:',
    '{"autoReject": boolean, "score": number (0-100), "feedback": string}',
    '',
    `Observation: ${r.observation}`,
    `Recommendation: ${r.recommendation}`,
    `Management response: ${r.response}`,
    `Proposed action plans: ${r.plans}`,
  ].join('\n');
}

export function analyticsInsightsPrompt(portfolioSummary: string): string {
  return [
    'Given this internal audit portfolio summary, provide strategic insights in',
    'Markdown with these sections: key observations, risk hotspots, positive trends,',
    'recommendations, and a next-quarter forecast. Be specific and actionable.',
    '',
    portfolioSummary,
  ].join('\n');
}
