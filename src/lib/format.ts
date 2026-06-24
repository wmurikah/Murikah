/** Small formatting helpers shared across insight pages and the RSS feed. */

const dateFormatter = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' });

export function formatDate(date: Date): string {
  return dateFormatter.format(date);
}

/** Machine-readable date for <time datetime>. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
