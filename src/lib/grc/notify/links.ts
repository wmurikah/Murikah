/**
 * Deep links for notifications. Emails need an absolute URL, and the GRC app is
 * served at grc.murikah.com, so links are built against that host. Import-free.
 */
const APP_BASE = 'https://grc.murikah.com';

export function entityLink(entityType: string, id: string): string {
  if (entityType === 'action_plan') return `${APP_BASE}/action-plans/${id}`;
  return `${APP_BASE}/work-papers/${id}`;
}
