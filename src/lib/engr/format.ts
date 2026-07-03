/**
 * View-layer formatting helpers. Repositories return integer minor units (KES
 * cents) and ISO timestamps; these format to major units and a short age only
 * where the value is shown, never in the data layer.
 */

export function formatMoneyMinor(minor: number, currency: string): string {
  const major = minor / 100;
  try {
    return new Intl.NumberFormat('en-KE', { style: 'currency', currency }).format(major);
  } catch {
    return `${currency} ${major.toFixed(2)}`;
  }
}

/**
 * Title-case a slug or code for display: split on hyphens, underscores and
 * spaces, then capitalise each word. So "hass" becomes "Hass" and
 * "hass-petroleum" becomes "Hass Petroleum". Already-cased input is preserved
 * (only the first letter of each word is forced up), so an acronym passed in as
 * "HPK" stays "HPK".
 */
export function titleCase(text: string): string {
  return text
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The human-facing label for an organisation. Prefer the stored name; fall back
 * to a title-cased slug only when no name is available, so a raw slug is never
 * shown as-is.
 */
export function orgDisplayName(name: string | null | undefined, slug: string): string {
  const trimmed = (name ?? '').trim();
  return trimmed.length > 0 ? trimmed : titleCase(slug);
}

// A short, human age like 3d, 5h, 12m, from an ISO timestamp.
export function relativeAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'just now';
}
