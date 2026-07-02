/**
 * Mileage amount, computed server-side. A client-supplied amount is never
 * trusted; the amount is always distance times the per-kilometre rate, in
 * integer minor units. Pure and self-contained so it can be unit tested with
 * node:test without the Astro or Cloudflare toolchain.
 */

/** amount_minor = round(distance_km * rate_per_km_minor), never negative. */
export function mileageAmountMinor(distanceKm: number, ratePerKmMinor: number): number {
  if (!Number.isFinite(distanceKm) || !Number.isFinite(ratePerKmMinor)) return 0;
  if (distanceKm < 0 || ratePerKmMinor < 0) return 0;
  return Math.round(distanceKm * ratePerKmMinor);
}
