/**
 * Delivery-side environment for the notification dispatcher.
 *
 * Read from the Cloudflare Worker env (the same source as the core Engineering
 * Rhythm env). None of these throw when missing: the production gate below turns
 * real sends off unless ENGR_ENV is exactly 'production' and the provider
 * credentials are present, so a preview or local run holds external messages in
 * the queue without ever contacting a customer. Secrets are set as Worker
 * secrets or in .dev.vars and are never committed.
 */
import { env } from 'cloudflare:workers';

export interface DeliveryEnv {
  /** Real external sends happen only in production. Anything else is held. */
  mode: 'production' | 'other';
  at: { username: string; apiKey: string; senderId: string } | null;
  email: { apiKey: string; from: string } | null;
  /** Shared secret guarding the cron endpoints. */
  cronSecret: string | null;
  /** Shared secret verifying provider delivery-receipt webhooks. */
  webhookSecret: string | null;
}

export interface DeliveryReadiness {
  production: boolean;
  email: { ready: boolean; reason: string | null };
  sms: { ready: boolean; reason: string | null };
}

/** Display-safe readiness: credential values are never returned. */
export function deliveryReadiness(env: DeliveryEnv): DeliveryReadiness {
  const production = env.mode === 'production';
  return {
    production,
    email: {
      ready: production && env.email !== null,
      reason: !production
        ? 'Production delivery is disabled.'
        : env.email
          ? null
          : 'EMAIL_API_KEY or EMAIL_FROM is missing.',
    },
    sms: {
      ready: production && env.at !== null,
      reason: !production
        ? 'Production delivery is disabled.'
        : env.at
          ? null
          : 'AT_USERNAME, AT_API_KEY or AT_SENDER_ID is missing.',
    },
  };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function getDeliveryEnv(): DeliveryEnv {
  const mode = env.ENGR_ENV === 'production' ? 'production' : 'other';

  const atUsername = nonEmpty(env.AT_USERNAME);
  const atApiKey = nonEmpty(env.AT_API_KEY);
  const atSenderId = nonEmpty(env.AT_SENDER_ID);
  const at =
    atUsername && atApiKey && atSenderId
      ? { username: atUsername, apiKey: atApiKey, senderId: atSenderId }
      : null;

  const emailApiKey = nonEmpty(env.EMAIL_API_KEY);
  const emailFrom = nonEmpty(env.EMAIL_FROM);
  const email = emailApiKey && emailFrom ? { apiKey: emailApiKey, from: emailFrom } : null;

  return {
    mode,
    at,
    email,
    cronSecret: nonEmpty(env.ENGR_CRON_SECRET),
    webhookSecret: nonEmpty(env.ENGR_WEBHOOK_SECRET),
  };
}
