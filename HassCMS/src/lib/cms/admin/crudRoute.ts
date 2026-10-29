/**
 * The shape every organisation master-data endpoint has, written once.
 *
 * Countries, affiliates, business units, departments and teams differ in their
 * columns and their validation and in nothing else: each one lists, reads one,
 * creates and edits, each one authorises the same two permissions, each one
 * records the same audit context. Writing that out five times would be five
 * chances to leave the guard off one of them, and the guard being absent from
 * one endpoint is indistinguishable from it being present until somebody looks.
 *
 * So the guard is not something an endpoint remembers to call. It is the first
 * thing this factory does, and an endpoint cannot be built without going
 * through it.
 *
 * There is no DELETE. Not "no DELETE handler": no verb, nothing that removes a
 * row, in this file or anything it calls. Deactivation is `active = 0`, and
 * history stays.
 */
import type { APIContext, APIRoute } from 'astro';
import type { Client } from '@libsql/client/web';
import { apiError, newTraceId } from '../errors.ts';
import {
  requireOrganisationManage,
  requireOrganisationView,
  writeContext,
  type Authorisation,
  type WriteContext,
} from './guard.ts';
import type { Validated } from './organisationInput.ts';
import type { WriteResult } from '../repos/organisationAdmin.ts';
import { failure, invalid, methodNotAllowed, ok, readJson, serverError } from './respond.ts';

export interface CollectionHandlers<TInput, TRow> {
  /** Used in the log tag and nowhere else. */
  readonly name: string;
  /**
   * The guards this collection authorises against.
   *
   * Parameters rather than a fixed pair, because Build Prompt 06 brought a
   * second subject with a different permission. They default to the
   * organisation guards, which is what every Build Prompt 05 caller passes by
   * omitting them, so no existing endpoint changed when this was added.
   *
   * They are still not optional in the sense that matters: an endpoint built
   * through this factory always runs one of them first, and there is no way to
   * build one that runs neither.
   */
  readonly read?: (context: APIContext) => Authorisation;
  readonly write?: (context: APIContext) => Authorisation;
  readonly list: (db: Client) => Promise<TRow[]>;
  readonly get: (db: Client, id: string) => Promise<TRow | null>;
  readonly validate: (raw: unknown) => Validated<TInput>;
  readonly create: (db: Client, input: TInput, ctx: WriteContext) => Promise<WriteResult<TRow>>;
  readonly update: (
    db: Client,
    id: string,
    input: TInput,
    ctx: WriteContext,
  ) => Promise<WriteResult<TRow>>;
}

/**
 * A database handle, or the response explaining why there is not one.
 *
 * An unconfigured or unreachable database is 503 and a trace id, never a stack
 * trace and never a 500 that suggests the caller did something wrong.
 */
async function connect(locals?: {
  cmsDb?: Client;
}): Promise<{ db: Client } | { response: Response }> {
  // THE REQUEST'S OWN CLIENT FIRST. The middleware authenticated this API
  // request moments ago and left its client on locals; creating another here
  // meant every mutation paid a second client and a second foreign-keys
  // pragma. The fallback below is unchanged and still serves the tests that
  // call endpoints with hand-built locals carrying no client.
  if (locals?.cmsDb !== undefined) return { db: locals.cmsDb };
  try {
    // Imported here rather than at the top of the file. `../env.ts` reaches for
    // the `cloudflare:workers` module, which only resolves inside the worker
    // runtime, and a static import would make this module unloadable anywhere
    // else. The authorisation tests import these endpoints directly and assert
    // that a refusal is decided before any connection is attempted; a top-level
    // import would make that test impossible to write, which is a poor reason
    // to leave a guard unproved.
    const [{ getCmsEnv }, { getDb }] = await Promise.all([import('../env.ts'), import('../db.ts')]);
    const env = getCmsEnv();
    return { db: await getDb(env) };
  } catch (error) {
    const traceId = newTraceId();
    console.error(`[cms.admin.connect] ${traceId}`, error);
    return {
      response: apiError('unavailable', 'This service is unavailable.', 503, traceId),
    };
  }
}

/** `GET` and `POST` on a collection. */
export function collectionRoute<TInput, TRow>(
  handlers: CollectionHandlers<TInput, TRow>,
): { GET: APIRoute; POST: APIRoute; ALL: APIRoute } {
  return {
    GET: async (context: APIContext) => {
      const auth = (handlers.read ?? requireOrganisationView)(context);
      if (!auth.ok) return auth.response;

      const connection = await connect(context.locals);
      if ('response' in connection) return connection.response;

      try {
        return ok({ items: await handlers.list(connection.db) });
      } catch (error) {
        return serverError(`admin.${handlers.name}.list`, error);
      }
    },

    POST: async (context: APIContext) => {
      const auth = (handlers.write ?? requireOrganisationManage)(context);
      if (!auth.ok) return auth.response;

      const body = await readJson(context.request);
      const parsed = handlers.validate(body);
      if (!parsed.ok) return invalid(parsed.errors);

      const connection = await connect(context.locals);
      if ('response' in connection) return connection.response;

      try {
        const result = await handlers.create(
          connection.db,
          parsed.value,
          writeContext(context.request, auth.principal),
        );
        return result.ok ? ok(result.value, 201) : failure(result);
      } catch (error) {
        return serverError(`admin.${handlers.name}.create`, error);
      }
    },

    ALL: () => methodNotAllowed('GET or POST'),
  };
}

/** `GET` and `PATCH` on one row. */
export function itemRoute<TInput, TRow>(
  handlers: CollectionHandlers<TInput, TRow>,
): { GET: APIRoute; PATCH: APIRoute; ALL: APIRoute } {
  return {
    GET: async (context: APIContext) => {
      const auth = (handlers.read ?? requireOrganisationView)(context);
      if (!auth.ok) return auth.response;

      const id = context.params.id ?? '';
      const connection = await connect(context.locals);
      if ('response' in connection) return connection.response;

      try {
        const row = await handlers.get(connection.db, id);
        return row ? ok(row) : apiError('not_found', 'That record could not be found.', 404);
      } catch (error) {
        return serverError(`admin.${handlers.name}.get`, error);
      }
    },

    PATCH: async (context: APIContext) => {
      const auth = (handlers.write ?? requireOrganisationManage)(context);
      if (!auth.ok) return auth.response;

      const id = context.params.id ?? '';
      const body = await readJson(context.request);
      const parsed = handlers.validate(body);
      if (!parsed.ok) return invalid(parsed.errors);

      const connection = await connect(context.locals);
      if ('response' in connection) return connection.response;

      try {
        const result = await handlers.update(
          connection.db,
          id,
          parsed.value,
          writeContext(context.request, auth.principal),
        );
        return result.ok ? ok(result.value) : failure(result);
      } catch (error) {
        return serverError(`admin.${handlers.name}.update`, error);
      }
    },

    ALL: () => methodNotAllowed('GET or PATCH'),
  };
}

export { connect };
