export const prerender = false;

/**
 * Send a test email to the acting admin through the connected Outlook
 * mailbox, proving the stored connection end to end. Admin only, gated on the
 * matrix (CONFIG update; a platform owner always passes). Deliberately not
 * behind the production gate: the gate exists so automated queue drains never
 * send from a preview, while this is a single, explicit admin action whose
 * whole point is verifying the connection. Tagged [grc.mail]; never a blank
 * 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { can } from '@grc/auth/rbac';
import { getGrcDeliveryEnv } from '@grc/notify/env';
import { prepareMailer } from '@grc/notify/sendMail';
import { buildTestEmail } from '@grc/notify/render';

const TAG = '[grc.mail]';
const PAGE = '/settings/email';
const back = (q: string): Response =>
  new Response(null, { status: 303, headers: { location: `${PAGE}?${q}` } });
const fail = (message: string): Response => back(`error=${encodeURIComponent(message)}`);

export const POST: APIRoute = async ({ locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!grc.isPlatformOwner && !can(locals, 'update', 'CONFIG')) {
    return fail('Only an administrator can send a test email.');
  }
  const to = grc.userEmail;
  if (!to) return fail('Your account has no email address to send the test to.');
  try {
    const env = getGrcEnv();
    const db = await getDb(env);
    const prepared = await prepareMailer(db, getGrcDeliveryEnv(), env.sessionSecret, Date.now());
    if (!prepared.ok) return fail(prepared.held);

    const message = buildTestEmail(prepared.mailer.address);
    const sent = await prepared.mailer.send({
      to,
      subject: message.subject,
      html: message.body,
      text: message.text,
    });
    if (!sent.ok) {
      console.error(TAG, 'test email failed:', sent.reason);
      return fail(`The test email could not be sent: ${sent.reason}`);
    }
    return back(
      `sent=${encodeURIComponent(`Test email sent to ${to} as ${prepared.mailer.address}.`)}`,
    );
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return fail('The test email could not be sent just now. Please try again.');
  }
};
