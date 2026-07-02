/**
 * SMS via Africa's Talking. Sends the notification body to the recipient's
 * phone. Outside production, or without credentials, it does not call the
 * provider and reports a dry-run.
 */
import type { Channel, SendResult } from './types';
import { DRY_RUN_NOTE } from './types';

interface AtRecipient {
  status?: string;
  messageId?: string;
  number?: string;
}
interface AtResponse {
  SMSMessageData?: { Recipients?: AtRecipient[] };
}

export const smsChannel: Channel = {
  key: 'SMS',
  async send(notification, recipient, env): Promise<SendResult> {
    if (!recipient.phone) return { ok: false, error: 'no phone number on file' };
    const message = notification.body ?? notification.subject ?? '';
    if (env.mode !== 'production' || !env.at) {
      return { ok: true, error: DRY_RUN_NOTE };
    }
    try {
      const res = await fetch('https://api.africastalking.com/version1/messaging', {
        method: 'POST',
        headers: {
          apiKey: env.at.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          username: env.at.username,
          to: recipient.phone,
          message,
          from: env.at.senderId,
        }),
      });
      if (!res.ok) return { ok: false, error: `africastalking http ${res.status}` };
      const data = (await res.json()) as AtResponse;
      const first = data.SMSMessageData?.Recipients?.[0];
      const status = first?.status ?? '';
      if (first && status !== 'Success') {
        return { ok: false, error: `africastalking status ${status}` };
      }
      return { ok: true, providerId: first?.messageId };
    } catch (err) {
      return {
        ok: false,
        error: `africastalking error ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
