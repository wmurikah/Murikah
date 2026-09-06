import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { requestDb } from '@/lib/cms/db';
import { requireInquiriesView } from '@/lib/cms/channels/access';
import { syncInquiryEmail } from '@/lib/cms/channels/inquirySync';

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const auth = requireInquiriesView(context);
  if (!auth.ok) return auth.response;
  try {
    const db = await requestDb(context.locals);
    const result = await syncInquiryEmail(db, env, auth.userId);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      { ok: false, errors: [{ field: 'sync', message: message.slice(0, 500) }] },
      { status: 409 },
    );
  }
};

export const ALL: APIRoute = () =>
  Response.json({ errors: [{ field: 'method', message: 'Use POST.' }] }, { status: 405 });
