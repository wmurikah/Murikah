/**
 * Central configuration for the demo sandbox and assistant safety layer.
 * Tune limits and retention here in one place.
 */

/** Session cookie name and lifetime. */
export const DEMO_COOKIE = 'mk_demo';
export const SESSION_TTL_SECONDS = 60 * 60 * 24; // 24 hours

/** Retention windows, enforced by the cron sweep. */
export const RETENTION = {
  /** Demo rows (invoices, workflow runs, CRM, sessions) older than this go. */
  demoHours: 24,
  /** Assistant conversation/message logs older than this go. */
  assistantDays: 30,
};

/** Rate limits, keyed by category. limit requests per windowSeconds per session. */
export const RATE_LIMITS = {
  demo: { limit: 30, windowSeconds: 600 }, // 30 per 10 minutes
  assistant: { limit: 20, windowSeconds: 3600 }, // 20 per hour
  upload: { limit: 10, windowSeconds: 3600 }, // 10 per hour
} as const;

export type RateCategory = keyof typeof RATE_LIMITS;

/** Upload limits for the optional document-extraction upload (transient only). */
export const UPLOAD = {
  maxBytes: 2 * 1024 * 1024, // 2MB
  allowedTypes: ['application/pdf', 'image/png', 'image/jpeg'],
};

/** The permanent badge shown on every demo surface. */
export const DEMO_BADGE = 'Demo environment. Sample data only. Resets automatically.';

/** The calm message returned on a rate-limit breach. */
export const RATE_LIMIT_MESSAGE =
  'You have reached the demo limit for now. Please try again shortly, or book a live demo.';

/** Generic, safe error message (never leak internals or provider errors). */
export const SAFE_ERROR_MESSAGE = 'Something went wrong on our side. Please try again shortly.';
