import type { DeliveryEnv } from './env';

export interface DeliveryReadiness {
  production: boolean;
  email: { ready: boolean; reason: string | null };
  sms: { ready: boolean; reason: string | null };
}

/** Pure readiness calculation, shared by runtime and dispatcher tests. */
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
