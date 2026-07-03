export const prerender = false;

/**
 * Logout endpoint. Clears the session cookie and redirects to the login screen.
 * Guarded by the middleware, so only a signed-in user reaches it.
 */
import type { APIRoute } from 'astro';
import { clearSession } from '@engr/auth/session';

export const POST: APIRoute = async ({ request }) => {
  // Match the set cookie: Secure in production (https), off for http development.
  const secure = new URL(request.url).protocol === 'https:';
  return new Response(null, {
    status: 303,
    headers: { location: '/login', 'set-cookie': clearSession(secure) },
  });
};
