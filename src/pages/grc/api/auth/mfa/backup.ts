export const prerender = false;

/**
 * Backup-code management from account security (Build Prompt 37): no setup
 * wall. `generate` replaces the unused codes with eight fresh ones, storing
 * only their SHA-256 hashes for verification plus the sealed plaintext so
 * the security screen can show them once; `hide` drops that sealed plaintext
 * once the user has saved them. Generation is refused while an authenticator
 * enrolment is pending, because that flow shows and confirms its own fresh
 * set. Every regeneration is recorded in security_events. Tagged
 * [grc.auth.mfa]; never a blank 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { seal } from '@grc/auth/secretBox';
import {
  generateBackupCodes,
  hashBackupCodes,
  replaceBackupCodes,
  hideBackupCodes,
} from '@grc/repos/mfa';
import { recordSecurityEvent } from '@grc/repos/loginAttempts';

const TAG = '[grc.auth.mfa]';
const PAGE = '/mfa/setup';
const back = (q: string): Response =>
  new Response(null, { status: 303, headers: { location: q === '' ? PAGE : `${PAGE}?${q}` } });

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  try {
    const env = getGrcEnv();
    const db = await getDb(env);
    const form = await request.formData().catch(() => new FormData());
    const op = String(form.get('op') ?? 'generate');

    if (op === 'hide') {
      await hideBackupCodes(db, grc.homeOrganizationId, grc.userId);
      return back('');
    }

    const codes = generateBackupCodes();
    const replaced = await replaceBackupCodes(
      db,
      grc.homeOrganizationId,
      grc.userId,
      await hashBackupCodes(codes),
      await seal(env.sessionSecret, JSON.stringify(codes)),
    );
    if (!replaced) {
      return back(
        `error=${encodeURIComponent(
          'Finish or cancel the authenticator app setup first; it comes with its own backup codes.',
        )}`,
      );
    }
    await recordSecurityEvent(db, {
      eventType: 'MFA_BACKUP_REGENERATED',
      severity: 'info',
      userId: grc.userId,
      actorEmail: grc.userEmail ?? null,
      ip: request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for'),
      details: 'The backup codes were regenerated; the previous set no longer works.',
    }).catch(() => undefined);
    return back('codes=1');
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return back(
      `error=${encodeURIComponent('The backup codes could not be changed just now. Please try again.')}`,
    );
  }
};
