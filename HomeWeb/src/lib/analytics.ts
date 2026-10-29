/** Event hooks only: no network calls, form values or sandbox records are collected.
 * Connect the dataLayer to the approved analytics provider before reporting conversions.
 */
export type MarketingEvent =
  | 'cta_call_click'
  | 'sandbox_click'
  | 'sandbox_start'
  | 'form_submit'
  | 'whatsapp_click';
export function track(event: MarketingEvent, location: string) {
  if (typeof window === 'undefined' || navigator.doNotTrack === '1') return;
  const detail = { event, location };
  const target = window as Window & { dataLayer?: Array<Record<string, string>> };
  (target.dataLayer ??= []).push(detail);
  window.dispatchEvent(new CustomEvent('murikah:analytics', { detail }));
}
