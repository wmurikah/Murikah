export const prerender = false;

/**
 * Users CRUD for the Setup module, SUPER_ADMIN (or platform owner) only, gated on
 * the USER module and scoped to the acting organisation. Edit changes email,
 * name, role, affiliate and phone; activate and deactivate flip the status.
 *
 * Nobody types a password here any more (Build Prompt 39). Create and reset both
 * mint a strong random temporary one, store only its canonical PBKDF2 hash, set
 * must_change_password, email it to its owner through the connected Graph
 * mailer, and stash it sealed for the acting admin to be shown exactly once on
 * the way back. A mail failure never undoes the account: the write stands, the
 * admin is told plainly that the email did not go, and the password is still
 * theirs to pass on. Those failures are logged under [grc.users].
 *
 * Every account must carry a valid email, unique across the whole platform: it
 * is the sign-in identity and the address the universal second-factor code goes
 * to, and sign-in resolves it across every instance. Guards: a platform-owner
 * account is never edited here, and an admin cannot deactivate their own account
 * (no lock-out). Every write is validated, hashed where relevant, and audited.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { can } from '@grc/auth/rbac';
import { hashPassword } from '@grc/auth/password';
import { generateTemporaryPassword } from '@grc/auth/temporaryPassword';
import { getGrcDeliveryEnv } from '@grc/notify/env';
import { sendAccountReadyEmail } from '@grc/notify/accountMail';
import { writeAuditLog } from '@grc/repos/audit';
import { stashTemporaryPassword } from '@grc/repos/tempPasswordHandoff';
import { requireText, optionalText, isValidEmail } from '@grc/repos/setupValidation';
import {
  createUser,
  updateUser,
  setUserActive,
  resetUserPassword,
  emailInUse,
  getManagedUser,
  type UserInput,
} from '@grc/repos/usersAdmin';

const TAG = '[grc.users]';
const PAGE = '/settings/users';
const back = (q: string): Response =>
  new Response(null, { status: 303, headers: { location: `${PAGE}?${q}` } });
const ok = (msg: string): Response => back(`saved=${encodeURIComponent(msg)}`);
const bad = (msg: string): Response => back(`error=${encodeURIComponent(msg)}`);

/**
 * Back to the page showing the generated password once. Only the user id
 * travels in the query string; the password itself went into the sealed,
 * read-once handoff row, so it never reaches the browser history or an access
 * log. `mailerror` carries why the email did not go, when it did not.
 */
function issued(userId: string, mailError: string | null): Response {
  const parts = [`credential=${encodeURIComponent(userId)}`];
  if (mailError) parts.push(`mailerror=${encodeURIComponent(mailError)}`);
  return back(parts.join('&'));
}

/** The posted profile, or null when a required field is missing or malformed. */
function profile(form: FormData): UserInput | null {
  const email = String(form.get('email') ?? '')
    .trim()
    .toLowerCase();
  const fullName = requireText(String(form.get('full_name') ?? ''), 160);
  const roleCode = requireText(String(form.get('role_code') ?? ''), 60);
  if (!fullName || !roleCode || !isValidEmail(email)) return null;
  return {
    email,
    fullName,
    roleCode,
    affiliateCode: optionalText(String(form.get('affiliate_code') ?? ''), 40),
    phone: optionalText(String(form.get('phone') ?? ''), 40),
  };
}

const PROFILE_REQUIRED = 'A full name, role and valid email address are required.';

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });

  const form = await request.formData();
  const op = String(form.get('op') ?? '');
  const action = op === 'create' ? 'create' : op === 'delete' ? 'delete' : 'update';
  if (!can(locals, action, 'USER')) return bad('You cannot manage users.');

  const env = getGrcEnv();
  const db = await getDb(env);
  const org = grc.organizationId;
  const audit = (a: string, id: string): Promise<void> =>
    writeAuditLog(db, {
      organizationId: org,
      userId: grc.userId,
      action: a,
      entityType: 'user',
      entityId: id,
    }).catch(() => undefined);

  /**
   * Mint a temporary password for an account that already exists, email it, and
   * stash it for the admin. Returns the mail failure reason, or null on success.
   * The stash is best-effort in the same way the audit is: losing it costs the
   * admin a convenience, and must not cost the user their new password, which
   * the email already carries.
   */
  const issueTemporaryPassword = async (
    userId: string,
    email: string,
    fullName: string,
    password: string,
  ): Promise<string | null> => {
    await stashTemporaryPassword(db, env.sessionSecret, org, userId, grc.userId, password).catch(
      (err: unknown) => {
        console.error(`${TAG} could not stash the temporary password for the admin`, err);
      },
    );
    const sent = await sendAccountReadyEmail(db, getGrcDeliveryEnv(), env.sessionSecret, {
      email,
      fullName,
      temporaryPassword: password,
    });
    if (sent.ok) return null;
    // Never the password itself, only why the send failed.
    console.error(`${TAG} account email to ${email} failed:`, sent.reason);
    return sent.reason;
  };

  try {
    if (op === 'create') {
      const input = profile(form);
      if (!input) return bad(PROFILE_REQUIRED);
      if (await emailInUse(db, input.email)) {
        return bad(`${input.email} already belongs to an account.`);
      }
      const password = generateTemporaryPassword();
      const id = await createUser(db, org, await hashPassword(password), input);
      await audit('USER.create', id);
      const mailError = await issueTemporaryPassword(id, input.email, input.fullName, password);
      return issued(id, mailError);
    }

    const userId = String(form.get('user_id') ?? '');
    if (!userId) return bad('No user was specified.');
    const target = await getManagedUser(db, org, userId);
    if (!target) return bad('That user was not found in this organisation.');
    if (target.isPlatformOwner) return bad('A platform-owner account cannot be managed here.');

    if (op === 'update') {
      const input = profile(form);
      if (!input) return bad(PROFILE_REQUIRED);
      if (await emailInUse(db, input.email, userId)) {
        return bad(`${input.email} already belongs to another account.`);
      }
      await updateUser(db, org, userId, input);
      await audit('USER.update', userId);
      return ok(`${input.fullName} saved.`);
    }
    if (op === 'activate' || op === 'deactivate') {
      if (op === 'deactivate' && userId === grc.userId) {
        return bad('You cannot deactivate your own account.');
      }
      await setUserActive(db, org, userId, op === 'activate');
      await audit(`USER.${op}`, userId);
      return ok(`${target.email} ${op === 'activate' ? 'activated' : 'deactivated'}.`);
    }
    if (op === 'reset_password') {
      if (!isValidEmail(target.email)) {
        return bad(
          `${target.fullName ?? 'That account'} has no valid email, so a new password cannot be sent. Add one first.`,
        );
      }
      const password = generateTemporaryPassword();
      await resetUserPassword(db, org, userId, await hashPassword(password));
      await audit('USER.reset_password', userId);
      const mailError = await issueTemporaryPassword(
        userId,
        target.email,
        target.fullName ?? '',
        password,
      );
      return issued(userId, mailError);
    }
    return bad('Unknown action.');
  } catch (err) {
    console.error(`${TAG} the change could not be saved`, err);
    return bad('The change could not be saved. Please try again.');
  }
};
