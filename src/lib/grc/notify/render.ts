/**
 * Notification rendering, ported from renderNotificationInline_. Each type has a
 * subject and an intro line; the body is a branded HTML email (navy header, a
 * details table drawn from the payload, an "Open Audit System" button and the
 * Hass Petroleum Group footer with replies to audit@hasspetroleum.com). When an
 * active email_templates row exists for the type its subject_template and
 * body_template are used instead, with {{variable}} interpolation from the
 * payload. Import-free (types only), so it is unit-tested directly.
 */
import type { NotificationType } from './types';

const NAVY = '#1F2D5C';
const REPLY_TO = 'audit@hasspetroleum.com';
const FOOTER = 'Hass Petroleum Group - Internal Audit Department';

export type Payload = Record<string, unknown>;

export interface Rendered {
  subject: string;
  body: string;
}

export interface EmailTemplate {
  subjectTemplate: string | null;
  bodyTemplate: string | null;
  isActive: boolean;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const val = (data: Payload, key: string): string => {
  const v = data[key];
  return v == null ? '' : String(v);
};

/** Replace {{variable}} tokens from the payload (missing keys become empty). */
export function interpolate(template: string, data: Payload): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => val(data, key));
}

// The subject and intro line per type; {{variable}} tokens interpolate from the payload.
const COPY: Record<NotificationType, { subject: string; intro: string }> = {
  WP_ASSIGNMENT: {
    subject: 'Work paper assigned: {{reference}}',
    intro: 'A work paper has been assigned to you.',
  },
  WP_SUBMITTED: {
    subject: 'Work paper submitted for review: {{reference}}',
    intro: 'A work paper has been submitted for your review.',
  },
  WP_REVIEW_REQUEST: {
    subject: 'Review requested: {{reference}}',
    intro: 'Your review has been requested on a work paper.',
  },
  WP_APPROVED: {
    subject: 'Work paper approved: {{reference}}',
    intro: 'A work paper has been approved.',
  },
  WP_REVISION_REQUIRED: {
    subject: 'Revision required: {{reference}}',
    intro: 'A work paper needs revision before it can proceed.',
  },
  WP_SENT_TO_AUDITEE: {
    subject: 'Action required: finding {{reference}}',
    intro: 'A finding has been sent to you for response.',
  },
  WP_STATUS_CHANGE: {
    subject: 'Work paper update: {{reference}}',
    intro: 'The status of a work paper has changed.',
  },
  RESPONSE_SUBMITTED: {
    subject: 'Response submitted: {{reference}}',
    intro: 'An auditee response has been submitted for review.',
  },
  RESPONSE_REVIEWED: {
    subject: 'Response reviewed: {{reference}}',
    intro: 'Your response has been reviewed.',
  },
  AP_ASSIGNED: {
    subject: 'Action plan assigned: {{reference}}',
    intro: 'An action plan has been assigned to you.',
  },
  AP_DELEGATED: {
    subject: 'Action plan delegated: {{reference}}',
    intro: 'An action plan has been delegated to you.',
  },
  AP_DELEGATION_RESPONSE: {
    subject: 'Delegation decision: {{reference}}',
    intro: 'A delegation you made has been decided.',
  },
  AP_IMPLEMENTED: {
    subject: 'Action plan implemented: {{reference}}',
    intro: 'An action plan has been marked implemented and awaits verification.',
  },
  AP_VERIFIED: {
    subject: 'Action plan verified: {{reference}}',
    intro: 'An action plan has been verified.',
  },
  AP_HOA_REVIEWED: {
    subject: 'Head of Audit review: {{reference}}',
    intro: 'The Head of Audit has reviewed an action plan.',
  },
  AP_OVERDUE: {
    subject: 'Overdue action plan: {{reference}}',
    intro: 'An action plan is overdue and needs attention.',
  },
  STALE_REMINDER: {
    subject: 'Reminder: draft work paper {{reference}}',
    intro: 'A draft work paper has been open for a while.',
  },
  OVERDUE_REMINDER: {
    subject: 'Reminder: overdue action plan {{reference}}',
    intro: 'An action plan remains overdue.',
  },
  DUE_SOON_REMINDER: {
    subject: 'Deadline approaching: action plan {{reference}}',
    intro: 'An action plan you own is due within the next few days.',
  },
  REQUIREMENT_ASSIGNED: {
    subject: 'Information requested: {{reference}}',
    intro: 'Internal Audit has asked you to provide information.',
  },
  REQUIREMENT_SUBMITTED: {
    subject: 'Information provided: {{reference}}',
    intro: 'An owner has provided information for your review.',
  },
  REQUIREMENT_MORE_INFO: {
    subject: 'Further information requested: {{reference}}',
    intro: 'Internal Audit has reviewed what you sent and asked for more.',
  },
  // The auditee loop (Build Prompt 68). Each subject names the finding and each
  // intro says who has to do what next, because these arrive at people with no
  // audit training and no reason to know the workflow: "a delegation status
  // changed" is a sentence that leaves the reader to work out whether it is
  // their turn.
  AUDITEE_DELEGATED: {
    subject: 'Response delegated to you: {{reference}}',
    intro:
      'The response to this finding has been delegated to you. Draft it, attach what supports it, and return it to your unit manager.',
  },
  AUDITEE_RETURNED: {
    subject: 'Draft response returned: {{reference}}',
    intro:
      'The delegated draft has been returned to the unit manager to review and release to internal audit.',
  },
  AUDITEE_RELEASED: {
    subject: 'Response released to audit: {{reference}}',
    intro: 'The management response to this finding has been released to internal audit.',
  },
  AUDITEE_DECIDED: {
    subject: 'Audit decision on your response: {{reference}}',
    intro: 'Internal audit has reviewed the response to this finding.',
  },
  PASSWORD_RESET: {
    subject: 'Reset your Internal Audit System password',
    intro:
      'A password reset was requested for your account. The link below is valid for 45 minutes and works once. If you did not request it, you can ignore this email.',
  },
};

const DETAIL_FIELDS: { key: string; label: string }[] = [
  { key: 'reference', label: 'Reference' },
  { key: 'title', label: 'Title' },
  { key: 'status', label: 'Status' },
  { key: 'riskRating', label: 'Risk' },
  { key: 'affiliate', label: 'Affiliate' },
  { key: 'ownerNames', label: 'Owners' },
  { key: 'dueDate', label: 'Due date' },
  { key: 'actorName', label: 'By' },
  { key: 'round', label: 'Round' },
  // The auditee loop's own detail (Build Prompt 68): where the finding now is,
  // and who was named by the move that caused the mail.
  { key: 'stage', label: 'Now with' },
  { key: 'delegatedTo', label: 'Delegated to' },
  { key: 'decision', label: 'Decision' },
  { key: 'comment', label: 'Comment' },
];

function detailsTable(data: Payload): string {
  const rows = DETAIL_FIELDS.filter((f) => val(data, f.key) !== '')
    .map(
      (f) =>
        `<tr><td style="padding:6px 12px;color:#687080;font-size:13px">${escapeHtml(f.label)}</td>` +
        `<td style="padding:6px 12px;color:#111827;font-size:13px;font-weight:600">${escapeHtml(val(data, f.key))}</td></tr>`,
    )
    .join('');
  if (!rows) return '';
  return `<table role="presentation" style="border-collapse:collapse;margin:16px 0;width:100%">${rows}</table>`;
}

function shell(title: string, intro: string, data: Payload): string {
  const link = val(data, 'link') || '#';
  const button = `<a href="${escapeHtml(link)}" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600;font-size:14px">Open Audit System</a>`;
  return [
    `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">`,
    `<div style="background:${NAVY};color:#fff;padding:18px 24px;font-size:16px;font-weight:700">${escapeHtml(title)}</div>`,
    `<div style="padding:24px">`,
    `<p style="color:#111827;font-size:14px;margin:0 0 4px">${escapeHtml(intro)}</p>`,
    detailsTable(data),
    `<p style="margin:20px 0 4px">${button}</p>`,
    `</div>`,
    `<div style="padding:16px 24px;background:#f8f4ea;color:#687080;font-size:12px;border-top:1px solid #e5e7eb">`,
    `${escapeHtml(FOOTER)}<br>Replies to <a href="mailto:${REPLY_TO}" style="color:${NAVY}">${REPLY_TO}</a>`,
    `</div></div>`,
  ].join('');
}

const HEADER = 'Internal Audit System';

/**
 * The types an auditee reads, which get the finding table and a button that
 * says what to do rather than the generic details grid (Build Prompt 68).
 *
 * These arrive at people with no audit training and no reason to know the
 * workflow. "Open Audit System" beside a grid of Reference, Status, Risk is a
 * system talking about itself; a line naming the finding and a button reading
 * "Log in and respond" is a request somebody can act on. It is deliberately the
 * same table the digest builds, so one finding and nine read alike.
 */
const AUDITEE_FACING = new Set<NotificationType>([
  'WP_SENT_TO_AUDITEE',
  'AUDITEE_DELEGATED',
  'AUDITEE_RETURNED',
  'AUDITEE_RELEASED',
  'AUDITEE_DECIDED',
]);

/** The auditee-facing body: the finding as one table row, and one instruction. */
function auditeeShell(intro: string, data: Payload): string {
  const link = val(data, 'link') || '#';
  const row: SubmittedRow = {
    reference: val(data, 'reference') || 'This finding',
    title: val(data, 'title'),
    detail: [val(data, 'stage'), val(data, 'riskRating')].filter(Boolean).join(' - '),
    link,
  };
  const extra = [
    ['Delegated to', val(data, 'delegatedTo')],
    ['Decision', val(data, 'decision')],
    ['Round', val(data, 'round')],
    ['Comment', val(data, 'comment')],
  ].filter(([, v]) => v !== '');
  const notes = extra.length
    ? `<table role="presentation" style="border-collapse:collapse;margin:0 0 16px;width:100%">${extra
        .map(
          ([label, value]) =>
            `<tr><td style="padding:6px 12px;color:#687080;font-size:13px">${escapeHtml(label)}</td>` +
            `<td style="padding:6px 12px;color:#111827;font-size:13px;font-weight:600">${escapeHtml(value)}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  return [
    `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">`,
    `<div style="background:${NAVY};color:#fff;padding:18px 24px;font-size:16px;font-weight:700">${escapeHtml(HEADER)}</div>`,
    `<div style="padding:16px 24px">`,
    `<p style="color:#111827;font-size:14px;margin:0">${escapeHtml(intro)}</p>`,
    digestTable([row], 'Now with'),
    notes,
    `<p style="margin:0 0 8px">${reviewButton(link, 'Log in and respond')}</p>`,
    `</div>`,
    `<div style="padding:16px 24px;background:#f8f4ea;color:#687080;font-size:12px;border-top:1px solid #e5e7eb">`,
    `${escapeHtml(FOOTER)}<br>Replies to <a href="mailto:${REPLY_TO}" style="color:${NAVY}">${REPLY_TO}</a>`,
    `</div></div>`,
  ].join('');
}

/** The inline branded rendering for a type, from its payload. */
export function renderInline(type: NotificationType, data: Payload): Rendered {
  const copy = COPY[type];
  const subject = interpolate(copy.subject, data);
  const intro = interpolate(copy.intro, data);
  const body = AUDITEE_FACING.has(type) ? auditeeShell(intro, data) : shell(HEADER, intro, data);
  return { subject, body };
}

/**
 * Render a notification, preferring an active DB template (with {{variable}}
 * interpolation) over the inline branded layout.
 */
export function renderNotification(
  template: EmailTemplate | null,
  type: NotificationType,
  data: Payload,
): Rendered {
  if (template && template.isActive && template.subjectTemplate && template.bodyTemplate) {
    return {
      subject: interpolate(template.subjectTemplate, data),
      body: interpolate(template.bodyTemplate, data),
    };
  }
  return renderInline(type, data);
}

/**
 * The dedicated sign-in code email (the email MFA method, Build Prompt 34): a
 * small branded message carrying the 6-digit code, with a plain-text
 * fallback. Sent directly through the Graph mailer, never queued, because a
 * sign-in cannot wait for the cron drain.
 */
export function buildOtpEmail(code: string): { subject: string; body: string; text: string } {
  const intro = 'Use this code to finish signing in. It works once and expires in ten minutes.';
  const warning = 'If you did not try to sign in, you can ignore this email.';
  const body = [
    `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">`,
    `<div style="background:${NAVY};color:#fff;padding:18px 24px;font-size:16px;font-weight:700">${escapeHtml(HEADER)}</div>`,
    `<div style="padding:24px">`,
    `<p style="color:#111827;font-size:14px;margin:0 0 12px">${escapeHtml(intro)}</p>`,
    `<p style="font-size:28px;font-weight:700;letter-spacing:0.3em;color:${NAVY};margin:0 0 12px">${escapeHtml(code)}</p>`,
    `<p style="color:#687080;font-size:13px;margin:0">${escapeHtml(warning)}</p>`,
    `</div>`,
    `<div style="padding:16px 24px;background:#f8f4ea;color:#687080;font-size:12px;border-top:1px solid #e5e7eb">${escapeHtml(FOOTER)}</div>`,
    `</div>`,
  ].join('');
  return {
    subject: 'Your sign-in code - Internal Audit System',
    body,
    text: `${intro} Your code: ${code}. ${warning}`,
  };
}

export interface AccountReadyEmail {
  fullName: string;
  temporaryPassword: string;
  signInLink: string;
}

/**
 * The "your account is ready" email a new user gets when an admin creates them,
 * and again when an admin resets their password (Build Prompt 39). It carries
 * the system-generated temporary password and the sign-in link, and says plainly
 * that the password must be changed on first use. Sent directly through the
 * Graph mailer, never queued: an account nobody can sign in to is not something
 * to leave sitting for the cron drain.
 */
export function buildAccountReadyEmail(opts: AccountReadyEmail): {
  subject: string;
  body: string;
  text: string;
} {
  const greeting = opts.fullName ? `Hello ${opts.fullName},` : 'Hello,';
  const intro =
    'An account has been created for you on the Internal Audit System. Sign in with the temporary password below.';
  const change =
    'You will be asked to choose your own password the first time you sign in, and a verification code will be emailed to this address as the second step.';
  const warning =
    'Keep this password to yourself. If you were not expecting this email, tell the internal audit team.';
  const body = [
    `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">`,
    `<div style="background:${NAVY};color:#fff;padding:18px 24px;font-size:16px;font-weight:700">${escapeHtml(HEADER)}</div>`,
    `<div style="padding:24px">`,
    `<p style="color:#111827;font-size:14px;margin:0 0 12px">${escapeHtml(greeting)}</p>`,
    `<p style="color:#111827;font-size:14px;margin:0 0 16px">${escapeHtml(intro)}</p>`,
    `<p style="font-size:22px;font-weight:700;letter-spacing:0.12em;color:${NAVY};margin:0 0 16px">${escapeHtml(opts.temporaryPassword)}</p>`,
    `<p style="margin:0 0 16px"><a href="${escapeHtml(opts.signInLink)}" style="display:inline-block;background:${NAVY};color:#fff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:6px">Sign in</a></p>`,
    `<p style="color:#111827;font-size:13px;margin:0 0 12px">${escapeHtml(change)}</p>`,
    `<p style="color:#687080;font-size:13px;margin:0">${escapeHtml(warning)}</p>`,
    `</div>`,
    `<div style="padding:16px 24px;background:#f8f4ea;color:#687080;font-size:12px;border-top:1px solid #e5e7eb">${escapeHtml(FOOTER)}</div>`,
    `</div>`,
  ].join('');
  return {
    subject: 'Your account is ready - Internal Audit System',
    body,
    text: `${greeting} ${intro} Temporary password: ${opts.temporaryPassword}. Sign in at ${opts.signInLink}. ${change} ${warning}`,
  };
}

/**
 * The test email the Settings -> Email screen sends to prove the connection:
 * a small branded message with a plain-text fallback beside the HTML body.
 */
export function buildTestEmail(mailbox: string): { subject: string; body: string; text: string } {
  const intro = `This is a test message from the Internal Audit System, sent as ${mailbox} through Microsoft Graph. If it reached you, the Outlook connection works.`;
  const body = [
    `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">`,
    `<div style="background:${NAVY};color:#fff;padding:18px 24px;font-size:16px;font-weight:700">${escapeHtml(HEADER)}</div>`,
    `<div style="padding:24px"><p style="color:#111827;font-size:14px;margin:0">${escapeHtml(intro)}</p></div>`,
    `<div style="padding:16px 24px;background:#f8f4ea;color:#687080;font-size:12px;border-top:1px solid #e5e7eb">${escapeHtml(FOOTER)}</div>`,
    `</div>`,
  ].join('');
  return { subject: 'Email connection test - Internal Audit System', body, text: intro };
}

/** One finding in a digest table (Build Prompt 53). */
export interface SubmittedRow {
  reference: string;
  title: string;
  /** The third column: the audit area and risk rating, or the status. */
  detail: string;
  link?: string;
}

/**
 * The tables a digest can carry (Build Prompt 60).
 *
 * A reminder used to render as the same bare block as everything else, one line
 * per work paper reading "Reminder: draft work paper WP-... [Open]", which is
 * neither a list nor a message: it is the payload with a link stapled to it. It
 * is now a table of its own, built by the same code as the submissions table, so
 * the two read alike and there is one place to keep Outlook-safe.
 */
export type DigestTable = 'submitted' | 'reminder' | 'auditee';

export interface DigestItem {
  subject: string;
  intro: string;
  link?: string;
  /**
   * Set when the item belongs in a table rather than as a block of its own.
   * This is what turns "seven findings are waiting" from seven emails, or one
   * email of seven repeated paragraphs, into one table read at a glance.
   */
  submitted?: SubmittedRow;
  /** Which table it belongs in; submissions when unsaid, as they always were. */
  table?: DigestTable;
}

/** Where a digest's call to action points, per table. */
export interface DigestLinks {
  /** The findings waiting on a reviewer. */
  review: string;
  /** The drafts a reminder is about. */
  drafts: string;
  /** The auditee's own queue of findings to answer (Build Prompt 68). */
  respond?: string;
}

const TH =
  'padding:8px 12px;text-align:left;font-size:12px;color:#687080;font-weight:600;border-bottom:1px solid #e5e7eb';
const TD =
  'padding:10px 12px;font-size:13px;color:#111827;border-bottom:1px solid #f1f3f7;vertical-align:top';

/**
 * The table of newly submitted findings.
 *
 * Deliberately a plain `<table>` with inline styles, no flexbox and no CSS
 * classes: Outlook renders through Word, which supports neither, and a layout
 * that collapses in the one client the head of audit actually uses is not a
 * layout. `role="presentation"` keeps a screen reader from announcing the
 * wrapper chrome as data.
 */
function digestTable(rows: SubmittedRow[], detailHeading: string): string {
  const body = rows
    .map((r) => {
      const ref = r.link
        ? `<a href="${escapeHtml(r.link)}" style="color:${NAVY};text-decoration:none;font-weight:600">${escapeHtml(r.reference)}</a>`
        : `<span style="font-weight:600">${escapeHtml(r.reference)}</span>`;
      return (
        `<tr><td style="${TD};white-space:nowrap">${ref}</td>` +
        `<td style="${TD}">${escapeHtml(r.title)}</td>` +
        `<td style="${TD};color:#687080">${escapeHtml(r.detail)}</td></tr>`
      );
    })
    .join('');
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
    `style="border-collapse:collapse;width:100%;margin:12px 0 20px">` +
    `<thead><tr><th style="${TH}">Reference</th><th style="${TH}">Title</th>` +
    `<th style="${TH}">${escapeHtml(detailHeading)}</th></tr></thead><tbody>${body}</tbody></table>`
  );
}

function reviewButton(link: string, label: string): string {
  return (
    `<a href="${escapeHtml(link)}" style="display:inline-block;background:${NAVY};color:#fff;` +
    `text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:600;font-size:14px">` +
    `${escapeHtml(label)}</a>`
  );
}

/**
 * Build one grouped digest email from a recipient's batched normal
 * notifications, so a person gets a single message rather than many.
 *
 * Submitted findings lead, as one table with a single call to action: a head of
 * audit who released twenty findings this morning wants one list to work
 * through, not twenty envelopes to open (Build Prompt 53). Anything else the
 * recipient has waiting follows underneath, so the run still produces exactly
 * one email per recipient. A single item that is not a submission keeps its own
 * subject, as before.
 */
export function buildDigest(items: DigestItem[], links?: DigestLinks): Rendered {
  const rowsIn = (table: DigestTable): SubmittedRow[] =>
    items
      .filter((i) => i.submitted != null && (i.table ?? 'submitted') === table)
      .map((i) => i.submitted as SubmittedRow);
  const submitted = rowsIn('submitted');
  const reminders = rowsIn('reminder');
  const auditee = rowsIn('auditee');
  const others = items.filter((i) => i.submitted == null);

  const subject =
    submitted.length > 0
      ? submitted.length === 1
        ? `Work paper submitted for review: ${submitted[0].reference}`
        : `${submitted.length} work papers submitted for review`
      : reminders.length > 0
        ? reminders.length === 1
          ? `Draft work paper waiting: ${reminders[0].reference}`
          : `${reminders.length} draft work papers waiting`
        : auditee.length > 1
          ? `${auditee.length} findings need your response`
          : items.length === 1
            ? items[0].subject
            : `Audit updates: ${items.length} notifications`;

  const sections: string[] = [];
  if (submitted.length > 0) {
    const lead =
      submitted.length === 1
        ? 'A work paper has been submitted for your review. Please log in and review it.'
        : `${submitted.length} work papers have been submitted for your review. Please log in and review them.`;
    sections.push(
      `<p style="color:#111827;font-size:14px;margin:0">${escapeHtml(lead)}</p>`,
      digestTable(submitted, 'Detail'),
      `<p style="margin:0 0 8px">${reviewButton(links?.review ?? '#', 'Review the queue')}</p>`,
    );
  }
  // The reminders, as their own table with their own lead and one button
  // (Build Prompt 60). Several drafts compile into one table in one email, for
  // the same reason submissions do: an auditor with six stale drafts wants one
  // list to work through, not six envelopes.
  if (reminders.length > 0) {
    if (submitted.length > 0) {
      sections.push(
        `<p style="margin:24px 0 0;color:#687080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">Still in draft</p>`,
      );
    }
    const lead =
      reminders.length === 1
        ? 'A work paper of yours is still in draft. Please review it and submit it when it is ready.'
        : `${reminders.length} work papers of yours are still in draft. Please review them and submit them when they are ready.`;
    sections.push(
      `<p style="color:#111827;font-size:14px;margin:0">${escapeHtml(lead)}</p>`,
      digestTable(reminders, 'Status'),
      `<p style="margin:0 0 8px">${reviewButton(links?.drafts ?? '#', 'Review the drafts')}</p>`,
    );
  }
  // The auditee's own table (Build Prompt 68). A finding arriving, a draft
  // coming back, a response released and audit's decision are all the same
  // shape to the person reading them: which finding, what it is called, and
  // where it now sits. Several at once compile into one table with one button,
  // because a unit manager copied on nine findings wants a list, not nine
  // envelopes.
  if (auditee.length > 0) {
    if (submitted.length > 0 || reminders.length > 0) {
      sections.push(
        `<p style="margin:24px 0 0;color:#687080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">Findings with you</p>`,
      );
    }
    const lead =
      auditee.length === 1
        ? 'There is an update on a finding you are named on. Please log in and respond.'
        : `There are updates on ${auditee.length} findings you are named on. Please log in and respond.`;
    sections.push(
      `<p style="color:#111827;font-size:14px;margin:0">${escapeHtml(lead)}</p>`,
      digestTable(auditee, 'Now with'),
      `<p style="margin:0 0 8px">${reviewButton(links?.respond ?? links?.review ?? '#', 'Log in and respond')}</p>`,
    );
  }
  if (others.length > 0) {
    if (submitted.length > 0 || reminders.length > 0 || auditee.length > 0) {
      sections.push(
        `<p style="margin:24px 0 0;color:#687080;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">Also waiting</p>`,
      );
    }
    sections.push(
      others
        .map((it) => {
          const link = it.link
            ? ` <a href="${escapeHtml(it.link)}" style="color:${NAVY};font-size:13px">Open</a>`
            : '';
          return (
            `<div style="padding:12px 0;border-bottom:1px solid #e5e7eb">` +
            `<p style="margin:0 0 4px;color:#111827;font-size:14px;font-weight:600">${escapeHtml(it.subject)}</p>` +
            `<p style="margin:0;color:#687080;font-size:13px">${escapeHtml(it.intro)}${link}</p></div>`
          );
        })
        .join(''),
    );
  }

  const body = [
    `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">`,
    `<div style="background:${NAVY};color:#fff;padding:18px 24px;font-size:16px;font-weight:700">${escapeHtml(HEADER)}</div>`,
    `<div style="padding:16px 24px">${sections.join('')}</div>`,
    `<div style="padding:16px 24px;background:#f8f4ea;color:#687080;font-size:12px;border-top:1px solid #e5e7eb">`,
    `${escapeHtml(FOOTER)}<br>Replies to <a href="mailto:${REPLY_TO}" style="color:${NAVY}">${REPLY_TO}</a>`,
    `</div></div>`,
  ].join('');
  return { subject, body };
}

/** The notification type whose digest is the submissions table. */
const SUBMISSION_TYPE = 'WP_SUBMITTED';

/** The reminder types that compile into the drafts table (Build Prompt 60). */
const REMINDER_TYPES = new Set(['STALE_REMINDER']);

/** The auditee loop's types, which compile into the auditee table (Prompt 68). */
const AUDITEE_TYPES = new Set([
  'WP_SENT_TO_AUDITEE',
  'AUDITEE_DELEGATED',
  'AUDITEE_RETURNED',
  'AUDITEE_RELEASED',
  'AUDITEE_DECIDED',
]);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The fields of a queued notification the digest actually reads. */
export interface DigestSource {
  id: string;
  batchType: string;
  recipientEmail: string;
  subject: string;
  payload: string;
}

/**
 * One queued row as the digest sees it.
 *
 * A submitted work paper becomes a table row rather than a block, so a reviewer
 * who has had ten findings released at them reads one table instead of ten
 * repeated paragraphs. The detail column is the audit area and the risk rating,
 * which is what tells them what they are being asked to look at; a row whose
 * payload carries neither still lists, with the title doing the work.
 */
function digestItem(row: DigestSource): DigestItem {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const link = str(payload.link) || undefined;
  if (row.batchType === SUBMISSION_TYPE) {
    const detail = [str(payload.auditArea), str(payload.riskRating)].filter(Boolean).join(' - ');
    return {
      subject: row.subject,
      intro: '',
      link,
      table: 'submitted',
      submitted: {
        reference: str(payload.reference) || row.subject,
        title: str(payload.title),
        detail,
        link,
      },
    };
  }
  // A reminder is a row in the drafts table, under the status it is in, rather
  // than a bare line with a link stapled to it (Build Prompt 60).
  if (REMINDER_TYPES.has(row.batchType)) {
    return {
      subject: row.subject,
      intro: '',
      link,
      table: 'reminder',
      submitted: {
        reference: str(payload.reference) || row.subject,
        title: str(payload.title),
        detail: str(payload.status) || 'Draft',
        link,
      },
    };
  }
  // A finding on the auditee's plate, in the same table shape (Build Prompt
  // 68). The third column is where it now sits, which is the fact a reader
  // needs to know whether it is their turn.
  if (AUDITEE_TYPES.has(row.batchType)) {
    return {
      subject: row.subject,
      intro: '',
      link,
      table: 'auditee',
      submitted: {
        reference: str(payload.reference) || row.subject,
        title: str(payload.title),
        detail: [str(payload.stage), str(payload.riskRating)].filter(Boolean).join(' - '),
        link,
      },
    };
  }
  return { subject: row.subject, intro: '', link };
}

/** One email the drain will send: its recipient, its content, and the rows it covers. */
export interface DigestPlan {
  email: string;
  subject: string;
  body: string;
  /** The queue rows this one email settles. */
  rowIds: string[];
}

/**
 * Group a run's normal-priority rows into one email per recipient.
 *
 * This is the function that makes "never one email per submitted finding" true,
 * so it lives here, pure and exported: a test can hand it the rows a batch
 * release actually queued and assert that exactly one email comes out, without
 * a mailbox, a network or a clock (Build Prompt 53). The review link is passed
 * in rather than imported, which is what keeps this module import-free.
 */
export function planNormalDigests(rows: DigestSource[], links: DigestLinks): DigestPlan[] {
  const byRecipient = new Map<string, DigestSource[]>();
  for (const row of rows) {
    const list = byRecipient.get(row.recipientEmail) ?? [];
    list.push(row);
    byRecipient.set(row.recipientEmail, list);
  }
  const plans: DigestPlan[] = [];
  for (const [email, group] of byRecipient) {
    const digest = buildDigest(group.map(digestItem), links);
    plans.push({
      email,
      subject: digest.subject,
      body: digest.body,
      rowIds: group.map((g) => g.id),
    });
  }
  return plans;
}
