/** Tiny HTTP helpers for the API endpoints. */

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** 303 redirect — used for no-JS form submissions (POST → GET). */
export function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

/** Best-effort client IP for rate-limiting. */
export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
