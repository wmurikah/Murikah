/** Exact file-host allow-list supplied by a platform operator. Never trust a
 * user-supplied hostname suffix or a browser's type=url validation. */
function allowedHosts(setting: string | undefined): Set<string> {
  return new Set(
    (setting ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(
        (host) =>
          /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) &&
          host.includes('.') &&
          !host.includes('..'),
      ),
  );
}

const REDIRECT_KEYS = new Set([
  'url',
  'next',
  'to',
  'target',
  'dest',
  'destination',
  'redirect',
  'redirect_url',
  'redirect_uri',
  'return',
  'return_url',
  'continue',
]);
const REDIRECT_SEGMENTS = new Set(['redirect', 'redirector', 'out', 'away', 'external']);

/** Returns a canonical HTTPS URL or null. Used both before insertion and
 * before rendering legacy database values as clickable links. */
export function safeAttachmentUrl(
  value: string | null | undefined,
  setting: string | undefined,
): string | null {
  if (!value || value.length > 500 || /[\s\\\u0000-\u001f\u007f<>]|%2f|%5c/i.test(value))
    return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash)
      return null;
    if (!allowedHosts(setting).has(url.hostname.toLowerCase())) return null;
    if ([...url.searchParams.keys()].some((key) => REDIRECT_KEYS.has(key.toLowerCase())))
      return null;
    if (
      url.pathname.split('/').some((part) => {
        try {
          return REDIRECT_SEGMENTS.has(decodeURIComponent(part).toLowerCase());
        } catch {
          return true;
        }
      })
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}
