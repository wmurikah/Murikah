import type { Client } from '@libsql/client/web';
import { hashPassword } from './password.ts';
import { newOneTimeToken, hashOneTimeToken } from './tokens.ts';
import { normalizeIdentityEmail } from './identityPolicy.ts';
import { issuePasswordReset, completePasswordReset } from '../repos/identityGateway.ts';
import type { RequestContext } from './loginFlow.ts';

export const RESET_TTL_MINUTES = 30;

export async function requestPasswordReset(
  db: Client,
  secret: string,
  emailInput: string,
  ctx: RequestContext,
) {
  const email = normalizeIdentityEmail(emailInput);
  if (!email) return { issued: false as const };
  const rawToken = newOneTimeToken();
  const tokenHash = await hashOneTimeToken(rawToken, secret);
  const result = await issuePasswordReset(db, {
    email,
    tokenHash,
    now: ctx.now,
    expiresAt: new Date(ctx.now.getTime() + RESET_TTL_MINUTES * 60_000),
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
  return result.issued ? { issued: true as const, rawToken } : { issued: false as const };
}

export async function resetPassword(
  db: Client,
  secret: string,
  rawToken: string,
  password: string,
  ctx: RequestContext,
): Promise<boolean> {
  if (rawToken.length < 40 || password.length < 12 || password.length > 128) return false;
  const tokenHash = await hashOneTimeToken(rawToken, secret);
  const passwordHash = await hashPassword(password);
  return completePasswordReset(db, {
    tokenHash,
    passwordHash,
    now: ctx.now,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });
}
