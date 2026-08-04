/**
 * The last-resort error boundary for the GRC platform, used by the middleware
 * around everything the /grc guard and its routes do. Pages carry their own
 * inline boundary (guardPageLoad + GrcErrorCard) so the shell survives a data
 * failure; this catches what nothing else did - an error thrown by the guard's
 * own queries, an endpoint that did not wrap, a route module failure - and turns
 * it into a logged, branded response instead of a blank 500. API paths get a
 * safe JSON error (never a stack); pages get a self-contained branded screen in
 * the Murikah navy/gold/paper palette (inline styles: the hashed stylesheet
 * cannot be referenced from the worker).
 */

/** The log tag for a failure on a root-relative app path, e.g. grc.work-papers.detail. */
export function grcErrorTag(appPath: string): string {
  if (appPath === '/' || appPath === '') return 'grc.home';
  const segments = appPath
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    // A segment that carries an identifier (digits, a UUID) names a detail
    // route; the id itself does not belong in the tag.
    .map((s) => (/\d/.test(s) ? 'detail' : s));
  return ['grc', ...segments].join('.');
}

/** Log the real cause with its tag and stack, so it is always in the Worker logs. */
export function logGrcError(appPath: string, err: unknown): void {
  console.error(
    `[${grcErrorTag(appPath)}] unhandled error`,
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
}

const ERROR_HTML = `<!doctype html>
<html lang="en-KE"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Something went wrong, Assurance OS</title><style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f8f4ea;color:#111827;display:grid;min-height:100vh;place-items:center;padding:1.5rem}main{max-width:34rem;background:#fffcf6;border:1px solid #d8d1c3;border-left:4px solid #c9a227;border-radius:.625rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem;color:#0b1733}p{margin:0 0 1.25rem;color:#687080}a{display:inline-block;min-height:2.75rem;line-height:2.75rem;padding:0 1.1rem;border-radius:.5rem;background:#0b1733;color:#f2f4fa;text-decoration:none;font-weight:600}</style></head><body><main><h1>Something went wrong</h1><p>This page could not be shown. The details have been logged on our side. Go back to the dashboard and try again, and contact your administrator if it keeps happening.</p><a href="/">Back to the dashboard</a></main></body></html>`;

/**
 * The response for an unhandled error: a safe JSON 500 for an API path, the
 * branded error screen for a page. Neither leaks the cause to the client.
 */
export function grcErrorResponse(isApi: boolean): Response {
  if (isApi) {
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
  return new Response(ERROR_HTML, {
    status: 500,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
