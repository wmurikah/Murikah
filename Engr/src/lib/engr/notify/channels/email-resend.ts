/**
 * Email via Resend. Sends the notification to the recipient's email, from the
 * verified EMAIL_FROM address. Outside production, or without credentials, it
 * does not call the provider and defers the row so it remains retryable.
 */
import type { Channel, SendResult } from './types';

interface ResendResponse {
  id?: string;
}

export const emailChannel: Channel = {
  key: 'EMAIL',
  async send(notification, recipient, env): Promise<SendResult> {
    if (!recipient.email) return { outcome: 'failed', message: 'no email address on file' };
    if (env.mode !== 'production' || !env.email) {
      return { outcome: 'deferred', message: 'email delivery is not configured' };
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
      if (!res.ok) return { outcome: 'failed', message: `resend http ${res.status}` };
      // HTTP success is the provider's acceptance signal. A malformed or empty
      // optional response body must not cause a retry of an accepted auth link.
      let providerId: string | undefined;
      try {
        providerId = ((await res.json()) as ResendResponse).id;
      } catch {
        // The message was still accepted; its id is only diagnostic metadata.
      }
      return { outcome: 'sent', providerId };
    } catch (err) {
      return {
        outcome: 'failed',
        message: `resend error ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
