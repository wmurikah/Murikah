/**
 * Deep links for notifications. Emails need an absolute URL, and the GRC app is
 * served at grc.murikah.com, so links are built against that host. Import-free.
 */
const APP_BASE = 'https://grc.murikah.com';

export function entityLink(entityType: string, id: string): string {
  if (entityType === 'action_plan') return `${APP_BASE}/action-plans/${id}`;
  return `${APP_BASE}/work-papers/${id}`;
}

/** The absolute reset-password link carrying the single-use raw token. */
export function passwordResetLink(token: string): string {
  return `${APP_BASE}/reset-password?token=${encodeURIComponent(token)}`;
}

/** The absolute sign-in link, for the "your account is ready" email. */
export function signInLink(): string {
  return `${APP_BASE}/login`;
}

/** The work-paper list, filtered to what is waiting to be reviewed. */
export const REVIEW_QUEUE_PATH = '/work-papers?status=Submitted';

/**
 * The review queue a submission digest points the head of audit at (Build
 * Prompt 53): the findings waiting on them, not a dashboard to navigate from.
 *
 * A reviewer opening this from an email is often signed out, so the guard
 * carries the destination through sign-in (`safeNextPath` in routing.ts) and
 * lands them here afterwards. The link itself stays a plain app URL: putting
 * the `next` hop in the email would be a second thing to keep in step, and the
 * guard already knows where the visitor was going.
 */
export function reviewQueueLink(): string {
  return `${APP_BASE}${REVIEW_QUEUE_PATH}`;
}
