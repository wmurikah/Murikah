import type { APIContext } from 'astro';
import { forbidden, unauthorised } from '../errors.ts';

/** Dedicated permission for configuring or testing AI providers. */
export const AI_MANAGE = 'ADMIN.AI.MANAGE';

export function canManageAi(permissions: readonly string[]): boolean {
  return permissions.includes(AI_MANAGE);
}

export type AiAuthorisation =
  | { readonly ok: true; readonly principal: NonNullable<APIContext['locals']['cms']> }
  | { readonly ok: false; readonly response: Response };

/**
 * AI provider administration is intentionally separate from user administration.
 * A person who may create/suspend users does not thereby gain access to model
 * credentials, provider verification, or external integration configuration.
 */
export function requireAiManage(context: APIContext): AiAuthorisation {
  const principal = context.locals.cms;
  if (!principal) return { ok: false, response: unauthorised() };
  if (!canManageAi(principal.user.permissions ?? [])) {
    return { ok: false, response: forbidden() };
  }
  return { ok: true, principal };
}
