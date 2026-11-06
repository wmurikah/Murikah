export const prerender = false;

/** Public, non-sensitive readiness check for the Worker and its notification
 * dependencies. Missing external providers are reported as held, not healthy
 * sends, while the endpoint remains available for uptime monitoring. */
import type { APIRoute } from 'astro';
import { getEngrEnv } from '@engr/env';
import { getDb } from '@engr/db';
import { deliveryReadiness, getDeliveryEnv } from '@engr/notify/env';

const reply = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export const GET: APIRoute = async () => {
  try {
    const db = await getDb(getEngrEnv());
    const schema = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM sqlite_schema
             WHERE type = 'table' AND name IN
                   ('notifications', 'org_settings', 'auth_tokens', 'user_mfa', 'mfa_recovery_codes',
                    'auth_sessions', 'auth_login_limits', 'auth_login_events')`,
      args: [],
    });
    if (Number(schema.rows[0]?.n ?? 0) !== 8) {
      return reply(
        {
          status: 'error',
          checks: {
            application: 'ok',
            database: 'reachable',
            notificationSchema: 'missing',
            authenticationSchema: 'missing',
          },
        },
        503,
      );
    }
    const delivery = deliveryReadiness(getDeliveryEnv());
    return reply(
      {
        status: 'ok',
        checks: {
          application: 'ok',
          database: 'reachable',
          notificationSchema: 'ok',
          authenticationSchema: 'ok',
          mfaEncryption: 'ready',
          emailDelivery: delivery.email.ready ? 'ready' : 'held',
          smsDelivery: delivery.sms.ready ? 'ready' : 'held',
        },
      },
      200,
    );
  } catch {
    return reply(
      {
        status: 'error',
        checks: { application: 'ok', database: 'unreachable' },
      },
      503,
    );
  }
};
