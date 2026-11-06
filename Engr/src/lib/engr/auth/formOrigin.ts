/** Check browser form submissions against the public URL before the Worker
 * rewrites /api and application paths under /engr for Astro routing. */
export function allowedFormMutation(request: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;

  const contentType = request.headers.get('content-type');
  const formLike =
    !contentType ||
    ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'].some((type) =>
      contentType.toLowerCase().includes(type),
    );
  if (!formLike) return true;

  const expectedOrigin = new URL(request.url).origin;
  const fetchSite = request.headers.get('sec-fetch-site');
  // Browsers set this header on form submissions. A sibling subdomain is
  // same-site but cross-origin, and must not be allowed to submit forms.
  if (fetchSite === 'cross-site' || fetchSite === 'same-site') return false;
  if (request.headers.get('origin') === expectedOrigin) return true;
  // Some browser/proxy combinations omit or alter Origin on same-origin form
  // posts. Fetch Metadata is a browser-controlled same-origin signal.
  if (fetchSite === 'same-origin') return true;

  if (request.headers.has('origin')) return false;
  const referer = request.headers.get('referer');
  if (!referer) return false;
  try {
    return new URL(referer).origin === expectedOrigin;
  } catch {
    return false;
  }
}
