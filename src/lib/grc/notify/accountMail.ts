/**
 * Send the "your account is ready" email (Build Prompt 39): the one place user
 * creation and an admin password reset both call to hand a new temporary
 * password to its owner.
 *
 * It goes straight out through the delegated Graph mailer (sendMail.ts, Build
 * Prompt 33) rather than onto the notification queue, for the same reason a
 * sign-in code does: an account nobody can get into is not something to leave
 * waiting for the cron drain. Sending is deliberately not behind the production
 * gate, because this is an explicit administrator action rather than an
 * automated drain.
 *
 * The result is returned rather than thrown. The account has already been
 * created by the time this runs, and a mail outage must never undo that or hide
 * it: the caller reports the failure to the admin and shows them the password to
 * pass on by hand, and owns the [grc.users] log line.
 */
import type { Client } from '@libsql/client/web';
import type { GrcDeliveryEnv } from './env';
import { prepareMailer } from './sendMail';
import { buildAccountReadyEmail } from './render';
import { signInLink } from './links';

export type AccountMailResult = { ok: true } | { ok: false; reason: string };

export interface AccountMailTarget {
  email: string;
  fullName: string;
  /** The plaintext temporary password. Passed through to the message, never stored or logged here. */
  temporaryPassword: string;
}

export async function sendAccountReadyEmail(
  db: Client,
  delivery: GrcDeliveryEnv,
  sessionSecret: string,
  target: AccountMailTarget,
): Promise<AccountMailResult> {
  const prepared = await prepareMailer(db, delivery, sessionSecret, Date.now());
  if (!prepared.ok) return { ok: false, reason: prepared.held };

  const mail = buildAccountReadyEmail({
    fullName: target.fullName,
    temporaryPassword: target.temporaryPassword,
    signInLink: signInLink(),
  });
  const sent = await prepared.mailer.send({
    to: target.email,
    subject: mail.subject,
    html: mail.body,
    text: mail.text,
  });
  return sent.ok ? { ok: true } : { ok: false, reason: sent.reason };
}
