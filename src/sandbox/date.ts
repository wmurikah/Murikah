export function atDayOffset(offset: number, now = new Date()): string {
  const date = new Date(now);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date.toISOString();
}

export function atMinuteOffset(offset: number, now = new Date()): string {
  return new Date(now.getTime() + offset * 60_000).toISOString();
}

export function formatDate(value: string, withYear = true): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat('en-KE', {
    day: '2-digit',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(date);
}

export function daysBetween(value: string, now = new Date()): number {
  const target = new Date(value);
  const today = new Date(now);
  today.setHours(0,0,0,0);
  target.setHours(0,0,0,0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export function relativeLabel(value: string): string {
  const days = daysBetween(value);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 1) return `in ${days} days`;
  return `${Math.abs(days)} days ago`;
}
