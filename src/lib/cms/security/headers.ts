/**
 * Security response headers, and the CSRF origin check, for CMS responses
 * only.
 *
 * WHY HERE AND NOT IN THE WORKER. `src/worker.ts` serves four products from
 * one script: the marketing site, Engineering Rhythm, the GRC platform and
 * this. A header set there would apply to all four, and a content security
 * policy tight enough for an application with no third-party scripts would
 * break a marketing page that legitimately embeds one. So these are applied
 * in the CMS branch of `src/middleware.ts`, on CMS responses, and section 0a
 * fences the worker for exactly this reason.
 *
 * The marketing site's headers are therefore unchanged, which is a property
 * a test asserts rather than a claim this comment makes.
 */

/**
 * The content security policy.
 *
 * `'self'` throughout, with two exceptions that are stated rather than
 * quietly permitted:
 *
 *   style-src 'unsafe-inline'   Astro emits the compiled Tailwind sheet as a
 *                               file, but component-scoped styles and the
 *                               `style` attribute on a server-rendered SVG
 *                               chart are inline. Removing this would mean
 *                               nonce-ing every chart, which is a lot of
 *                               machinery for a directive that stops nothing
 *                               an attacker could not do with a class.
 *   img-src data:               The wordmark and the icons are inline SVG,
 *                               and a data: image is how a favicon and an
 *                               embedded asset reach the page.
 *
 * `script-src 'self'` with no `unsafe-inline` and no `unsafe-eval` is the
 * directive that matters: every script in this product is a module Astro
 * emits to a file, so a reflected `<script>` cannot execute even if one ever
 * reached the markup.
 *
 * `frame-ancestors 'none'` is the clickjacking control and is the modern
 * spelling of X-Frame-Options; both are sent, because the older header is
 * still honoured by things that do not read CSP.
 *
 * `form-action 'self'` stops a reflected form posting a session cookie to
 * somebody else's host.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  // The application talks only to itself. There is no analytics endpoint, no
  // error reporter and no third-party API anywhere in this product.
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  // An https page must never load an http subresource, and this upgrades
  // rather than blocking, so a mixed-content mistake degrades to working.
  'upgrade-insecure-requests',
].join('; ');

/**
 * A per-request nonce, for the one script that cannot be an external module.
 *
 * WHY A NONCE AND NOT A HASH. A hash changes every time the script does, so
 * the next person to edit that block breaks the page and finds out from a
 * browser console rather than from the build. A nonce is regenerated per
 * response and never goes stale.
 *
 * WHY ONE SCRIPT NEEDS IT AT ALL. The rail's pinned state is read from
 * localStorage and applied to the body BEFORE the rail paints. Deferring that
 * to an external module means every pinned user sees a narrow rail widen a
 * frame later, on every page load. That is the only script in the product with
 * that constraint; everything else is a module Astro emits to a file.
 */
export function newCspNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * The policy, with the request's own nonce written into `script-src`.
 *
 * `'self'` still carries every bundled module. The nonce adds exactly one
 * inline block per response and nothing else: no `unsafe-inline`, which would
 * hand the same permission to anything that ever got reflected into the
 * markup, and which is the whole reason this directive exists.
 */
export function contentSecurityPolicy(nonce: string): string {
  return CONTENT_SECURITY_POLICY.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`);
}

export interface HeaderOptions {
  /** HSTS is sent only over https. On http it is meaningless and ignored. */
  readonly secure: boolean;
  /** The request's nonce, when a page carries an inline script. */
  readonly nonce?: string;
}

/**
 * The same response, with headers that can be written to.
 *
 * WHY THIS IS NEEDED, AND WHAT IT COST. `Response.redirect()` returns a
 * response whose header guard is `immutable`: every `set` on it throws
 * `TypeError: Can't modify immutable headers`. The CMS middleware sets
 * `cache-control` and then the whole security header set on every response it
 * returns, so the first one to arrive immutable threw, the throw escaped the
 * route's own try/catch (it happened after the route returned), and Astro
 * turned it into a 500 with an empty body.
 *
 * That is the entire reason the three provider sign-in buttons returned 500.
 * The route was behaving correctly: no provider is configured, so
 * `providerConfig` threw, the route caught it and returned a redirect back to
 * the sign-in page carrying `provider_error`. The redirect was then handed to
 * a middleware that could not write to it. The visible fault was three broken
 * buttons; the actual fault was that NO route in this product could return a
 * `Response.redirect()` without a 500, including the callback that completes
 * a successful sign-in.
 *
 * A blanket rebuild would be wrong: `new Response(body, init)` refuses status
 * 101 and rejects a body on 204 and 304, so a response that is already
 * writable is returned untouched and only an immutable one is rebuilt. The
 * probe is a write, because the guard is not readable from script.
 */
export function writableResponse(response: Response): Response {
  try {
    // A header that is set on every CMS response a moment later anyway, so
    // the probe leaves nothing behind that the caller did not want.
    response.headers.set('x-content-type-options', 'nosniff');
    return response;
  } catch {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}

/**
 * Apply the headers to a CMS response, in place.
 *
 * Set rather than appended, so a handler that set one itself does not end up
 * with two conflicting values.
 */
export function applySecurityHeaders(response: Response, options: HeaderOptions): void {
  const headers = response.headers;
  headers.set(
    'content-security-policy',
    options.nonce === undefined ? CONTENT_SECURITY_POLICY : contentSecurityPolicy(options.nonce),
  );
  // A browser must not sniff a JSON response into HTML and run it.
  headers.set('x-content-type-options', 'nosniff');
  // The path of a CMS page can name a customer or an order, so a full URL
  // must not travel to another origin. This keeps it for our own navigation
  // and sends only the origin outward.
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('x-frame-options', 'DENY');
  // Nothing in this product uses a camera, a microphone, geolocation or
  // payment. Denying them costs nothing and removes a class of surprise.
  headers.set(
    'permissions-policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  );
  headers.set('cross-origin-opener-policy', 'same-origin');
  headers.set('cross-origin-resource-policy', 'same-origin');
  if (options.secure) {
    // Two years, subdomains included. Not preloaded: preloading is a decision
    // with a slow undo and belongs to whoever owns the domain, not here.
    headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
  }
}

// ---- CSRF ---------------------------------------------------------------------

/**
 * The verbs that change something. A GET must never mutate, and this list is
 * also what makes that rule enforceable rather than aspirational.
 */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Whether a mutating request came from this site.
 *
 * SAMESITE ALONE IS NOT ENOUGH, which section 5 is explicit about. The cookie
 * is SameSite=Lax, which stops a cross-site POST carrying it in every current
 * browser, but it is one setting, it is enforced by the client, and a browser
 * that gets it wrong or a user on an old build has no second line. So this is
 * the second line: a mutating request must declare an Origin or a Referer,
 * and it must be ours.
 *
 * ORIGIN, NOT A TOKEN. A signed double-submit token would refuse the same
 * attack and would cost every form a hidden field, every fetch a header, and
 * the application a token mint, a rotation story and a failure mode where a
 * stale tab cannot submit. The origin check needs none of that. If a future
 * flow genuinely needs a token, this is one function to extend.
 *
 * A REQUEST WITH NEITHER HEADER IS REFUSED. Browsers send Origin on every
 * cross-origin request and on every same-origin POST; a request with neither
 * is not a browser doing a normal thing, and defaulting to allow would make
 * the whole check optional for anybody able to omit a header.
 */
export function isSameOrigin(request: Request, url: URL): boolean {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return true;

  const origin = request.headers.get('origin');
  if (origin !== null && origin !== '') {
    // `null` is what a sandboxed iframe and some redirects send. It is not
    // this host, so it is refused.
    if (origin === 'null') return false;
    try {
      return new URL(origin).host === url.host;
    } catch {
      return false;
    }
  }

  const referer = request.headers.get('referer');
  if (referer !== null && referer !== '') {
    try {
      return new URL(referer).host === url.host;
    } catch {
      return false;
    }
  }

  return false;
}

/** The refusal. Deliberately terse: it explains nothing an attacker can use. */
export function crossOriginRefusal(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'cross_origin_refused',
        message: 'That request did not come from this site.',
      },
    }),
    {
      status: 403,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    },
  );
}
