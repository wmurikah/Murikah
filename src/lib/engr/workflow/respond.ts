/**
 * Shared helpers for the work-order action endpoints. Each endpoint parses its
 * body, calls the state machine, then finishes here: an API client (Accept:
 * application/json) gets the updated work order and the right status code; a
 * browser form is redirected back to the screen it came from so it re-renders
 * with the new state (progressive enhancement, no client JavaScript required).
 */
import type { Client } from '@libsql/client/web';
import type { TransitionResult } from './workOrderState';
import { getWorkOrderDetail } from '../repos/workOrders';

type FailCode = 'not_found' | 'forbidden' | 'conflict' | 'invalid';

export function statusForCode(code: FailCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'forbidden':
      return 403;
    case 'conflict':
      return 409;
    case 'invalid':
      return 422;
  }
}

export function wantsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('application/json');
}

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sameOrigin(candidate: string, base: string): boolean {
  try {
    return new URL(candidate).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

// Prefer returning to the referring screen; fall back to a sensible default.
function destination(request: Request, fallback: string): string {
  const ref = request.headers.get('referer');
  if (ref && sameOrigin(ref, request.url)) return ref;
  return new URL(fallback, request.url).toString();
}

export function redirectResponse(request: Request, fallback: string, query = ''): Response {
  const base = destination(request, fallback);
  const url = query ? `${base}${base.includes('?') ? '&' : '?'}${query}` : base;
  return new Response(null, { status: 303, headers: { location: url } });
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      return (await request.json()) as Record<string, unknown>;
    }
    const form = await request.formData();
    const out: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) out[key] = value;
    return out;
  } catch {
    return {};
  }
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/**
 * Finish a state-machine transition: JSON with the updated work order, or a
 * redirect back to the screen. Conflicts return 409, permission failures 403.
 */
export async function finishTransition(
  request: Request,
  result: TransitionResult,
  db: Client,
  orgId: string,
  workOrderId: string,
  fallbackRedirect: string,
): Promise<Response> {
  if (result.ok) {
    if (wantsJson(request)) {
      const workOrder = await getWorkOrderDetail(db, orgId, workOrderId);
      return jsonResponse({ ok: true, status: result.status, workOrder }, 200);
    }
    return redirectResponse(request, fallbackRedirect);
  }
  const status = statusForCode(result.code);
  if (wantsJson(request)) {
    return jsonResponse({ ok: false, error: result.code, message: result.message }, status);
  }
  return redirectResponse(request, fallbackRedirect, `error=${result.code}`);
}
