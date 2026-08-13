/**
 * Deep links for notifications. Emails need an absolute URL, and the GRC app is
 * served at grc.murikah.com, so links are built against that host. Import-free.
 */
const APP_BASE = 'https://grc.murikah.com';

export function entityLink(entityType: string, id: string): string {
  if (entityType === 'action_plan') return `${APP_BASE}/action-plans/${id}`;
  if (entityType === 'requirement') return `${APP_BASE}/requirements/${id}`;
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

/** The work-paper list, filtered to the drafts a reminder is about. */
export const DRAFT_QUEUE_PATH = '/work-papers?status=Draft';

/** The auditee's own queue of findings to answer (Build Prompt 68). */
export const RESPOND_QUEUE_PATH = '/auditee-responses';

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

/**
 * The drafts a reminder digest points at (Build Prompt 60). A reminder is about
 * work the reader still owes, so its one button opens that work rather than the
 * review queue, which holds what somebody else owes them.
 */
export function draftQueueLink(): string {
  return `${APP_BASE}${DRAFT_QUEUE_PATH}`;
}

/**
 * The auditee's own queue (Build Prompt 68): the findings they are named on and
 * owe an answer to. A unit manager opening a digest wants the list of what is
 * theirs, not the reviewer's queue of what somebody else owes them.
 */
export function respondQueueLink(): string {
  return `${APP_BASE}${RESPOND_QUEUE_PATH}`;
}

/** Every destination a digest can offer, resolved once for a drain run. */
export function digestLinks(): { review: string; drafts: string; respond: string } {
  return { review: reviewQueueLink(), drafts: draftQueueLink(), respond: respondQueueLink() };
}
