/**
 * Channel adapter contract. Each adapter delivers one notification to one
 * recipient and reports the outcome. The production gate lives inside every
 * adapter: outside production it returns ok without contacting the provider, so
 * a dry-run cannot leak to a real customer regardless of caller.
 */
import type { DeliveryEnv } from '../env';

export interface OutboundNotification {
  id: string;
  orgId: string;
  channel: string;
  subject: string | null;
  body: string | null;
  templateKey: string | null;
  entityType: string | null;
  entityId: string | null;
}

export interface DeliveryRecipient {
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface SendResult {
  ok: boolean;
  providerId?: string;
  error?: string;
}

export interface Channel {
  readonly key: string;
  send(
    notification: OutboundNotification,
    recipient: DeliveryRecipient,
    env: DeliveryEnv,
  ): Promise<SendResult>;
}

export const DRY_RUN_NOTE = 'dry-run: non-production, not sent';
