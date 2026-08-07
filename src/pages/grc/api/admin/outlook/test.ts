export const prerender = false;

/**
 * Send a test email to the acting owner through the connected Outlook mailbox,
 * proving the stored connection end to end. Deliberately not behind the
 * production gate: that gate exists so automated queue drains never send from a
 * preview, while this is a single, explicit action whose whole point is
 * verifying the connection. Tagged [grc.mail]; never a blank 500.
 *
 * Platform owner only (Build Prompt 44), for the same reason as connect and the
 * callback (AC-02). A test send is not read-only: Microsoft rotates the consumer
 * refresh token on redemption, so the sender writes the rotated token back to
 * the shared record, and an auth failure marks that record stale, which shows
 * every tenant "Not connected". Both are writes to the one row every customer's
 * notifications depend on, so they carry the owner's authority.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
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
  if (!grc.isPlatformOwner) {
    return fail('The shared mailbox is tested by the platform owner.');
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
