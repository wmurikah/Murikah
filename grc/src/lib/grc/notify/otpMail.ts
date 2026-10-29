/**
 * Issue and send an email one-time sign-in code (Build Prompt 34): the one
 * place the login endpoint, the resend endpoint and email enrolment all call.
 * Enforces the resend cooldown, stores only the code's hash on the user's MFA
 * record (repos/mfa.ts), sends the dedicated template directly through the
 * delegated Graph mailer (sendMail.ts, Build Prompt 33), and records the send
 * in security_events. Sending is deliberately not behind the production gate:
 * like the test email, a sign-in code is an explicit user-triggered action,
 * not an automated queue drain. Failures are logged under [grc.auth.mfa] by
 * the callers, who own the user-facing message.
 */
import type { Client } from '@libsql/client/web';
import type { GrcDeliveryEnv } from './env';
import { prepareMailer } from './sendMail';
import { buildOtpEmail } from './render';
import { hashToken } from '@grc/auth/session';
import { generateOtpCode, newChallenge, resendCooldownMs } from '@grc/auth/emailOtp';
import { saveMfaChallenge, type MfaRecord } from '@grc/repos/mfa';
import { recordSecurityEvent } from '@grc/repos/loginAttempts';

export type OtpIssueResult =
  | { ok: true }
  | {
      ok: false;
      /** True when the refusal is only the resend cooldown. */
      cooldown: boolean;
      reason: string;
    };

export interface OtpTarget {
  organizationId: string;
  userId: string;
  email: string;
  ip: string | null;
}

/** Generate, store (hash only) and email a fresh code for the target user. */
export async function issueEmailOtp(
  db: Client,
  delivery: GrcDeliveryEnv,
  sessionSecret: string,
  target: OtpTarget,
  record: MfaRecord,
): Promise<OtpIssueResult> {
  const nowMs = Date.now();
  const waitMs = resendCooldownMs(record.challenge, nowMs);
  if (waitMs > 0) {
    return {
      ok: false,
      cooldown: true,
      reason: `Please wait ${Math.ceil(waitMs / 1000)} seconds before requesting another code.`,
    };
  }

  const code = generateOtpCode();
  const stored = await saveMfaChallenge(
    db,
    target.organizationId,
    target.userId,
    newChallenge(await hashToken(code), nowMs),
  );
  if (!stored) return { ok: false, cooldown: false, reason: 'There is no enrolment to send for.' };

  const prepared = await prepareMailer(db, delivery, sessionSecret, nowMs);
  if (!prepared.ok) return { ok: false, cooldown: false, reason: prepared.held };
  const mail = buildOtpEmail(code);
  const sent = await prepared.mailer.send({
    to: target.email,
    subject: mail.subject,
    html: mail.body,
    text: mail.text,
  });
  if (!sent.ok) return { ok: false, cooldown: false, reason: sent.reason };

  await recordSecurityEvent(db, {
    eventType: 'MFA_OTP_SENT',
    severity: 'info',
    userId: target.userId,
    actorEmail: target.email,
    ip: target.ip,
    details: 'A sign-in code was emailed for the email MFA method.',
  }).catch(() => undefined);
  return { ok: true };
}
