export const prerender = false;

/**
 * Users CRUD for the Setup module, SUPER_ADMIN (or platform owner) only, gated on
 * the USER module and scoped to the acting organisation. Create issues an initial
 * password with must_change_password; edit changes email, name, role, affiliate
 * and phone; reset issues a new initial password; activate and deactivate flip
 * the status. Every account must carry a valid, unique email: it is the sign-in
 * identity and the address the universal second-factor code goes to (Build
 * Prompt 37), so create and edit both refuse a missing, malformed or duplicate
 * one. Guards: a platform-owner account is never edited here, and an admin
 * cannot deactivate their own account (no lock-out). Every write is validated,
 * hashed where relevant, and audited.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { can } from '@grc/auth/rbac';
import { hashPassword } from '@grc/auth/password';
import { writeAuditLog } from '@grc/repos/audit';
import {
  requireText,
  optionalText,
  isValidEmail,
  isValidInitialPassword,
} from '@grc/repos/setupValidation';
import {
  createUser,
  updateUser,
  setUserActive,
  resetUserPassword,
  userEmailExists,
  getManagedUser,
  type UserInput,
} from '@grc/repos/usersAdmin';

const PAGE = '/settings/users';
const back = (q: string): Response =>
  new Response(null, { status: 303, headers: { location: `${PAGE}?${q}` } });
const ok = (msg: string): Response => back(`saved=${encodeURIComponent(msg)}`);
const bad = (msg: string): Response => back(`error=${encodeURIComponent(msg)}`);

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

  const db = await getDb(getGrcEnv());
  const org = grc.organizationId;
  const audit = (a: string, id: string): Promise<void> =>
    writeAuditLog(db, {
      organizationId: org,
      userId: grc.userId,
      action: a,
      entityType: 'user',
      entityId: id,
    }).catch(() => undefined);

  try {
    if (op === 'create') {
      const input = profile(form);
      if (!input) return bad(PROFILE_REQUIRED);
      const password = String(form.get('password') ?? '');
      if (!isValidInitialPassword(password)) {
        return bad('The initial password must be at least eight characters.');
      }
      if (await userEmailExists(db, org, input.email)) {
        return bad(`${input.email} is already a user.`);
      }
      const hash = await hashPassword(password);
      const id = await createUser(db, org, hash, input);
      await audit('USER.create', id);
      return ok(`User ${input.email} created; they must change their password at first sign-in.`);
    }

    const userId = String(form.get('user_id') ?? '');
    if (!userId) return bad('No user was specified.');
    const target = await getManagedUser(db, org, userId);
    if (!target) return bad('That user was not found in this organisation.');
    if (target.isPlatformOwner) return bad('A platform-owner account cannot be managed here.');

    if (op === 'update') {
      const input = profile(form);
      if (!input) return bad(PROFILE_REQUIRED);
      if (await userEmailExists(db, org, input.email, userId)) {
        return bad(`${input.email} is already another user.`);
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
      const password = String(form.get('password') ?? '');
      if (!isValidInitialPassword(password)) {
        return bad('The new password must be at least eight characters.');
      }
      await resetUserPassword(db, org, userId, await hashPassword(password));
      await audit('USER.reset_password', userId);
      return ok(`${target.email}'s password was reset; they must change it at next sign-in.`);
    }
    return bad('Unknown action.');
  } catch (err) {
    console.error('[grc.setup.users]', err);
    return bad('The change could not be saved. Please try again.');
  }
};
