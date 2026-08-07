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

/** The inline branded rendering for a type, from its payload. */
export function renderInline(type: NotificationType, data: Payload): Rendered {
  const copy = COPY[type];
  const subject = interpolate(copy.subject, data);
  const intro = interpolate(copy.intro, data);
  return { subject, body: shell(HEADER, intro, data) };
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

export interface DigestItem {
  subject: string;
  intro: string;
  link?: string;
}

/**
 * Build one grouped digest email from a recipient's batched normal
 * notifications, so a person gets a single message rather than many (port of the
 * digest builder). A single item keeps its own subject.
 */
export function buildDigest(items: DigestItem[]): Rendered {
  const subject =
    items.length === 1 ? items[0].subject : `Audit updates: ${items.length} notifications`;
  const blocks = items
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
    .join('');
  const body = [
    `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">`,
    `<div style="background:${NAVY};color:#fff;padding:18px 24px;font-size:16px;font-weight:700">${escapeHtml(HEADER)}</div>`,
    `<div style="padding:8px 24px">${blocks}</div>`,
    `<div style="padding:16px 24px;background:#f8f4ea;color:#687080;font-size:12px;border-top:1px solid #e5e7eb">`,
    `${escapeHtml(FOOTER)}<br>Replies to <a href="mailto:${REPLY_TO}" style="color:${NAVY}">${REPLY_TO}</a>`,
    `</div></div>`,
  ].join('');
  return { subject, body };
}
