/**
 * The one place probability changes shape.
 *
 * The database stores a fraction: `opportunities.probability` and
 * `pipeline_stages.default_probability` are both `CHECK(BETWEEN 0 AND 1)`.
 * People read percentages. Every conversion between the two happens in this
 * file and nowhere else, because the failure mode of doing it casually is
 * silent: a percentage written to the database unconverted passes the CHECK
 * up to 1 and becomes nonsense above it, so `80` is rejected but `0.8` typed
 * as "0.8%" is accepted and quietly wrong by a factor of a hundred.
 *
 * The boundary is:
 *  - inbound, `percentToFraction` in the validators: the interface collects
 *    whole percentages (an integer 0 to 100) and the validator converts once;
 *  - outbound, `fractionToPercentLabel` in pages and components: the stored
 *    fraction becomes "80%" at render time.
 *
 * Nothing else multiplies or divides by 100.
 */

/** A whole percentage from a form, to the stored fraction. */
export function percentToFraction(percent: number): number {
  return percent / 100;
}

/** A stored fraction, to the whole-number label a person reads. */
export function fractionToPercentLabel(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * Whether a submitted percentage is usable: a finite number from 0 to 100.
 * Fractions are refused here on purpose. A caller sending `0.8` almost
 * certainly means 80% and has skipped the conversion; accepting it would
 * store a probability of under one percent without complaint.
 */
export function isValidPercent(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}
