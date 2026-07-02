/**
 * Email via Resend. Sends the notification to the recipient's email, from the
 * verified EMAIL_FROM address. Outside production, or without credentials, it
 * does not call the provider and reports a dry-run.
 */
import type { Channel, SendResult } from './types';
import { DRY_RUN_NOTE } from './types';

interface ResendResponse {
  id?: string;
}

export const emailChannel: Channel = {
  key: 'EMAIL',
  async send(notification, recipient, env): Promise<SendResult> {
    if (!recipient.email) return { ok: false, error: 'no email address on file' };
    if (env.mode !== 'production' || !env.email) {
      return { ok: true, error: DRY_RUN_NOTE };
    }
    const subject = notification.subject ?? 'Engineering Rhythm notification';
    const text = notification.body ?? subject;
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.email.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.email.from,
          to: [recipient.email],
          subject,
          text,
        }),
      });
      if (!res.ok) return { ok: false, error: `resend http ${res.status}` };
      const data = (await res.json()) as ResendResponse;
      return { ok: true, providerId: data.id };
    } catch (err) {
      return {
        ok: false,
        error: `resend error ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
