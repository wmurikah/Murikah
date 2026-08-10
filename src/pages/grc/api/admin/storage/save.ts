export const prerender = false;

/**
 * The Evidence storage settings screen's one write endpoint (Build Prompt 51).
 *
 * Five actions, because they are five buttons on one screen and each is a small
 * write against the same row: fill in a provider's credentials, test the
 * connection, choose the folder, make it the active provider, or disconnect it.
 * Splitting them into five files would spread one screen's behaviour across
 * five, and each would repeat the same gate and the same redirect.
 *
 * Every action is scoped to the acting organisation, which is never taken from
 * the request: `grc.organizationId` is the only organisation this endpoint can
 * write, so no submitted field can reach another customer's connection.
 *
 * This is per-organisation configuration naming the customer's own storage
 * account, so it is gated on their own `CONFIG.update` grant rather than on the
 * platform owner (Build Prompt 44, AC-02, governs `GLOBAL`-scoped writes).
 *
 * A submitted secret field left blank keeps the stored one, so an administrator
 * can change the bucket without retyping the key they can only see masked.
 *
 * Tagged [grc.storage]; never a blank 500.
 */
import type { APIRoute } from 'astro';
import { getGrcEnv } from '@grc/env';
import { getDb } from '@grc/db';
import { can } from '@grc/auth/rbac';
import {
  isProviderCode,
  missingFields,
  providerDefinition,
  type ProviderCode,
} from '@grc/storage/provider';
import { buildProvider } from '@grc/storage/resolve';
import {
  activateConnection,
  disconnect,
  loadConnection,
  recordTestResult,
  saveConnection,
  setFolder,
} from '@grc/repos/storageConnections';
import { writeAuditLog } from '@grc/repos/audit';

const TAG = '[grc.storage]';
const PAGE = '/settings/storage';
const back = (q: string): Response =>
  new Response(null, { status: 303, headers: { location: `${PAGE}?${q}` } });
const fail = (message: string): Response => back(`error=${encodeURIComponent(message)}`);
const done = (message: string): Response => back(`done=${encodeURIComponent(message)}`);

const ACTIONS = new Set(['save', 'test', 'folder', 'activate', 'disconnect']);

export const POST: APIRoute = async ({ request, locals }) => {
  const grc = locals.grc;
  if (!grc) return new Response(null, { status: 303, headers: { location: '/login' } });
  if (!grc.isPlatformOwner && !can(locals, 'update', 'CONFIG')) {
    return fail('Evidence storage is configured by an administrator.');
  }

  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const provider = String(form.get('provider') ?? '');
  if (!ACTIONS.has(action)) return fail('That is not an action this screen offers.');
  if (!isProviderCode(provider)) return fail('That storage provider is not one this app offers.');

  const env = getGrcEnv();
  const org = grc.organizationId;
  const name = providerDefinition(provider)?.name ?? provider;

  try {
    const db = await getDb(env);
    const existing = await loadConnection(db, env.sessionSecret, org, provider);

    if (action === 'disconnect') {
      await disconnect(db, org, provider);
      await audit(db, grc, provider, 'STORAGE.disconnect');
      return done(`${name} disconnected. Evidence already stored there is unaffected.`);
    }

    if (action === 'save') {
      const definition = providerDefinition(provider);
      if (!definition || definition.kind !== 'fields') {
        return fail(`${name} is connected with the Connect button, not by filling in fields.`);
      }
      // A blank secret means "leave the stored one alone", because the screen
      // only ever showed it masked. A blank non-secret field is a real change.
      const config: Record<string, string> = { ...(existing?.config ?? {}) };
      for (const field of definition.fields) {
        const submitted = String(form.get(field.name) ?? '').trim();
        if (submitted !== '') config[field.name] = submitted;
        else if (!field.secret) delete config[field.name];
      }
      const missing = missingFields(provider, config);
      if (missing.length > 0) {
        return fail(`${name} still needs: ${missing.join(', ')}.`);
      }
      await saveConnection(db, env.sessionSecret, org, {
        provider,
        config,
        folderId: existing?.folderId ?? null,
        folderName: existing?.folderName ?? null,
        status: 'pending',
        statusDetail: 'Saved. Test the connection to confirm the credentials work.',
        connectedBy: grc.userId,
      });
      await audit(db, grc, provider, 'STORAGE.save');
      return done(`${name} saved. Test the connection to confirm it works.`);
    }

    if (!existing) return fail(`${name} is not configured yet.`);

    if (action === 'test') {
      const instance = buildProvider(provider, existing.config, existing.folderId);
      if (!instance) {
        await recordTestResult(db, org, provider, false, 'The stored settings are incomplete.');
        return fail(`${name} is not fully configured yet.`);
      }
      const result = await instance.testConnection();
      await recordTestResult(
        db,
        org,
        provider,
        result.ok,
        result.ok ? result.detail : result.error,
      );
      await audit(db, grc, provider, result.ok ? 'STORAGE.test_ok' : 'STORAGE.test_failed');
      return result.ok
        ? done(`${name}: ${result.detail}`)
        : fail(`${name} could not be reached: ${result.error}`);
    }

    if (action === 'folder') {
      const folderId = String(form.get('folder_id') ?? '').trim();
      const folderName = String(form.get('folder_name') ?? '').trim() || folderId || 'Root';
      await setFolder(db, org, provider, folderId, folderName);
      await audit(db, grc, provider, 'STORAGE.folder');
      return done(`${name} will store evidence in ${folderName}. Test it to confirm.`);
    }

    // activate
    if (existing.status !== 'connected') {
      return fail(`Test ${name} first: evidence should not depend on an untested connection.`);
    }
    await activateConnection(db, org, provider);
    await audit(db, grc, provider, 'STORAGE.activate');
    return done(`${name} is now where new evidence is stored.`);
  } catch (err) {
    console.error(TAG, err instanceof Error ? (err.stack ?? err.message) : String(err));
    return fail('That could not be saved just now. Please try again.');
  }
};

/** Best-effort audit: a failed log line must not undo a completed change. */
async function audit(
  db: Parameters<typeof writeAuditLog>[0],
  grc: { organizationId: string; userId: string },
  provider: ProviderCode,
  action: string,
): Promise<void> {
  await writeAuditLog(db, {
    organizationId: grc.organizationId,
    userId: grc.userId,
    action,
    entityType: 'storage_connection',
    entityId: provider,
  }).catch(() => undefined);
}
