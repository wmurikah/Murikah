/**
 * Transactional email via Resend, called with `fetch` from a server endpoint.
 * The whole thing is behind an env check: if RESEND_API_KEY (or the recipient)
 * is missing, it no-ops and reports `skipped`, so builds and submissions still
 * work without a key. Never throws to the caller.
 */
import type { ContactInput } from '@/lib/validation';

export interface EmailEnv {
  RESEND_API_KEY?: string;
  CONTACT_NOTIFY_EMAIL?: string;
  RESEND_FROM_EMAIL?: string;
}

export interface EmailResult {
  sent: boolean;
  skipped?: boolean;
  error?: string;
}

export async function sendContactNotification(
  env: EmailEnv,
  input: ContactInput,
): Promise<EmailResult> {
  const apiKey = env.RESEND_API_KEY;
  const to = env.CONTACT_NOTIFY_EMAIL;
  const from = env.RESEND_FROM_EMAIL ?? 'Murikah <onboarding@resend.dev>';

  // Graceful no-op when not configured.
  if (!apiKey || !to) return { sent: false, skipped: true };

  const text = [
    `New enquiry via murikah.com`,
    ``,
    `Name:         ${input.name}`,
    `Organisation: ${input.organisation || ', '}`,
    `Role:         ${input.role || ', '}`,
    `Email:        ${input.email}`,
    ``,
    `Message:`,
    input.message,
  ].join('\n');

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        reply_to: input.email,
        subject: `New enquiry from ${input.name}`,
        text,
      }),
    });

    if (!res.ok) {
      return { sent: false, error: `Resend responded ${res.status}` };
    }
    return { sent: true };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : String(error) };
  }
}
