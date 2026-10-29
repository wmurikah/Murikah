import type { APIContext, MiddlewareNext } from 'astro';
import { toCmsAppPath } from '@hasscms/lib/hosts/cms';
import {
  applySecurityHeaders,
  writableResponse,
  isSameOrigin,
  crossOriginRefusal,
  newCspNonce,
} from '@hasscms/lib/cms/security/headers';
import { getCmsEnv } from '@hasscms/lib/cms/env';
import { renamedPath } from '@hasscms/lib/cms/routes';
import { getDb as getCmsDb } from '@hasscms/lib/cms/db';
import { startTrace, serverTimingValue, slowRequestLine, SLOW_REQUEST_MS } from '@hasscms/lib/cms/perf';
import { readSessionCookie as readCmsSessionCookie } from '@hasscms/lib/cms/auth/cookie';
import { resolveSession as resolveCmsSession } from '@hasscms/lib/cms/auth/loginFlow';
import { clearSessionCookie as clearCmsCookie, isSecureRequest } from '@hasscms/lib/cms/auth/cookie';
import {
  isPublicPath as isCmsPublicPath,
  isCmsAuthEntryPage,
  isOidcCallbackPath,
  isApiPath as isCmsApiPath,
  isAppPath,
  isPortalPath,
  homeFor,
  APP_ROOT,
  PORTAL_ROOT,
  LOGIN_PATH,
  EXPIRED_FLAG,
} from '@hasscms/lib/cms/routes';

export async function cmsMiddleware(context: APIContext, next: MiddlewareNext): Promise<Response> {
  const { pathname } = context.url;
  // ---- CMS host branch (/cms routes) ---------------------------------------
  // The branch itself is unchanged from Build Prompt 00, so cms.murikah.com
  // keeps resolving and the Cloudflare custom domain never has to be
  // re-pointed. Inside it, this is the whole of the CMS's route protection.
  //
  // Server-side, by redirect. There are no client-side guards anywhere in this
  // product, and no client-side authentication store: the principal is resolved
  // here, once per request, and read from locals by whatever renders. That is
  // why a refresh keeps the user signed in with no code, why there is no
  // loading state to design, and why protected markup can never flash on an
  // unauthorised screen: it is never sent.
  //
  // The public list is default-deny (see @hasscms/lib/cms/routes): a page added later
  // is protected because nobody had to remember to protect it.
  if (pathname === '/cms' || pathname.startsWith('/cms/')) {
    const appPath = toCmsAppPath(pathname);
    context.locals.cmsPath = appPath;

    // Service became Helpdesk. Before anything else, because an old link
    // should land on the new page whether or not the visitor is signed in,
    // and one prefix rule covers every sub-path including the dynamic ones.
    const renamed = renamedPath(appPath);
    if (renamed !== null) {
      return writableResponse(context.redirect(renamed + (context.url.search ?? ''), 301));
    }
    // One nonce per response, minted before anything renders, so the layout
    // can stamp it on the rail's inline script and the header can name the
    // same value. A hash would go stale the next time that script is edited.
    const nonce = newCspNonce();
    context.locals.cmsNonce = nonce;

    const isApi = isCmsApiPath(appPath);
    let anonymousReason: string = 'no_cookie';
    // Where this request's time goes, phase by phase. Read by the layout and
    // the pages through locals, reported as Server-Timing below.
    const trace = startTrace();
    context.locals.cmsPerf = trace;

    try {
      const env = getCmsEnv();
      const endAuth = trace.begin('auth');
      const db = await getCmsDb(env);
      const resolution = await resolveCmsSession(
        db,
        env.sessionSecret,
        readCmsSessionCookie(context.request),
        new Date(),
      );
      endAuth();
      if (resolution.kind === 'authenticated') {
        context.locals.cms = {
          sessionId: resolution.sessionId,
          user: resolution.identity,
          can: (code: string) => resolution.identity.permissions.includes(code),
        };
        // THE CLIENT IS KEPT, NOT THROWN AWAY. Everything downstream in this
        // request — layout, page, drawers — reads it via requestDb(), so an
        // authenticated page costs ONE client and ONE foreign-keys pragma
        // instead of one of each per rendering unit. Attached only on an
        // authenticated request: an anonymous one renders the sign-in page,
        // which has no business holding a database handle.
        context.locals.cmsDb = db;
      } else {
        anonymousReason = resolution.reason;
      }
    } catch {
      // Anonymous. An unconfigured TURSO_CMS_* or an unreachable database must
      // not take the host down: the sign-in page and the static assets have no
      // business depending on the database being up.
    }

    const principal = context.locals.cms;

    // A page response for a signed-in user must never be cached. Without this,
    // the Back button can redisplay the shell from the browser's cache after
    // sign-out, which looks exactly like still being signed in.
    const guarded = async (): Promise<Response> => {
      if (principal) {
        // Signed in. Send each user type to its own surface, and keep them
        // there. The sign-in page is not somewhere a signed-in user belongs.
        const home = homeFor(principal.user.userType, principal.user.permissions);
        if (isCmsAuthEntryPage(appPath)) return context.redirect(home, 302);
        if (appPath === '/') return context.redirect(home, 302);
        if (principal.user.userType === 'EXTERNAL' && isAppPath(appPath)) {
          // Never rendered, not merely hidden.
          return context.redirect(PORTAL_ROOT, 302);
        }
        if (principal.user.userType === 'INTERNAL' && isPortalPath(appPath)) {
          // The decision: staff are sent to /app rather than shown the portal.
          // The portal is the customer's surface and a staff user has no
          // customer_portal_memberships row, so it would render an empty shell
          // and invite confusion about which surface they are on. One home per
          // user type is easier to reason about than a read-only visit.
          return context.redirect(APP_ROOT, 302);
        }
        return next();
      }

      // Not signed in.
      if (isCmsPublicPath(appPath)) return next();

      // An API answers for itself: a JSON client wants 401, not the HTML of a
      // sign-in page delivered under a 302 it did not ask to follow.
      if (isApi) return next();

      // A session that ran out gets told so; one that never existed does not.
      const expired = anonymousReason === 'expired' || anonymousReason === 'revoked';
      const destination = expired ? `${LOGIN_PATH}?${EXPIRED_FLAG}=1` : LOGIN_PATH;
      const response = context.redirect(destination, 302);
      // Clear the dead cookie on the way past, so the browser stops sending a
      // credential that will never work again.
      if (anonymousReason !== 'no_cookie') {
        response.headers.append(
          'set-cookie',
          clearCmsCookie({ secure: isSecureRequest(context.request) }),
        );
      }
      return response;
    };

    // CSRF, before anything mutates. Section 0a puts this here rather than in
    // the worker because the worker serves four products and this policy is
    // the CMS's alone. SameSite=Lax already stops a cross-site POST carrying
    // the cookie; this is the second line, because SameSite is one setting
    // enforced by the client and a security control should not have exactly
    // one of those.
    // Apple returns its authorization response with `form_post`, which is
    // necessarily cross-origin. This one callback family is authenticated by
    // the consumed OIDC state, nonce and PKCE verifier; every other mutating
    // CMS request still requires same-origin.
    if (!isOidcCallbackPath(appPath) && !isSameOrigin(context.request, context.url)) {
      const refused = crossOriginRefusal();
      applySecurityHeaders(refused, { secure: isSecureRequest(context.request), nonce });
      return refused;
    }

    // WRITABLE FIRST. A route may return `Response.redirect()`, whose headers
    // are immutable; setting one throws and Astro turns the throw into an
    // empty 500. See writableResponse: this is why every provider sign-in
    // button returned 500, and it would have caught the successful sign-in
    // callback too.
    const endPage = trace.begin('page');
    const response = writableResponse(await guarded());
    endPage();
    if (principal) {
      response.headers.set('cache-control', 'no-store');
      // Server-Timing on authenticated PAGE responses: names and durations
      // only, never SQL, identifiers or secrets. Not on API responses — the
      // JSON callers are our own scripts, and DevTools already times fetches.
      // Headers are set before the body streams, so a streamed page reports
      // the time to create its response, which is the part the server owns.
      if (!isApi) {
        const value = serverTimingValue(trace);
        if (value !== '') response.headers.set('server-timing', value);
      }
      // One structured line for an unusually slow request, so Workers Logs
      // can name the path and the phase without anyone attaching a debugger.
      if (trace.total() >= SLOW_REQUEST_MS) {
        console.warn(slowRequestLine(appPath, trace));
      }
    }
    // On every CMS response, signed in or not, including the sign-in page and
    // every redirect. A policy that applied only to authenticated pages would
    // leave the one page an unauthenticated attacker can reach unprotected.
    applySecurityHeaders(response, { secure: isSecureRequest(context.request), nonce });
    return response;
  }

  return next();
}

export const onRequest = cmsMiddleware;
