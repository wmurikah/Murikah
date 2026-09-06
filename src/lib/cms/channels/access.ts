import type { APIContext } from 'astro';

export const CHANNELS_MANAGE = 'ADMIN.CHANNELS.MANAGE';
export const INQUIRIES_VIEW = 'SERVICE.INQUIRIES.VIEW';
export const INQUIRIES_REPLY = 'SERVICE.INQUIRIES.REPLY';

export function canManageChannels(permissions: readonly string[]): boolean {
  return permissions.includes(CHANNELS_MANAGE);
}

export function canViewInquiries(permissions: readonly string[]): boolean {
  return permissions.includes(INQUIRIES_VIEW) || permissions.includes(INQUIRIES_REPLY);
}

export function canReplyToInquiries(permissions: readonly string[]): boolean {
  return permissions.includes(INQUIRIES_REPLY);
}

export type ChannelAuthorisation =
  | { readonly ok: true; readonly userId: string; readonly permissions: readonly string[] }
  | { readonly ok: false; readonly response: Response };

function authorise(
  context: APIContext,
  allowed: (permissions: readonly string[]) => boolean,
): ChannelAuthorisation {
  const principal = context.locals.cms;
  if (!principal) {
    return {
      ok: false,
      response: Response.json(
        { errors: [{ field: 'session', message: 'Sign in to continue.' }] },
        { status: 401 },
      ),
    };
  }
  const permissions = principal.user.permissions ?? [];
  if (!allowed(permissions)) {
    return {
      ok: false,
      response: Response.json(
        { errors: [{ field: 'permission', message: 'You do not have access to this function.' }] },
        { status: 403 },
      ),
    };
  }
  return { ok: true, userId: principal.user.userId, permissions };
}

export function requireChannelsManage(context: APIContext): ChannelAuthorisation {
  return authorise(context, canManageChannels);
}

export function requireInquiriesView(context: APIContext): ChannelAuthorisation {
  return authorise(context, canViewInquiries);
}

export function requireInquiriesReply(context: APIContext): ChannelAuthorisation {
  return authorise(context, canReplyToInquiries);
}
