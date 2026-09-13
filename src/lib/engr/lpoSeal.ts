/**
 * Deterministic sealing of an LPO into an audit-grade document.
 *
 * One canonical serialisation is used at issue (to compute sealed_hash) and at
 * verify (to recompute and compare). It fixes the field order, uses integer minor
 * units with no locale formatting, sorts the lines by a stable key (wo_no),
 * includes the currency and the issue timestamp, and treats a null as an empty
 * string, so the same document always yields the same bytes. Because both paths
 * call this one function, an innocent formatting difference can never produce a
 * false "Changed" verdict.
 *
 * The module is pure (only the global Web Crypto and TextEncoder, no relative
 * imports), so it runs under the type-stripping test runner and in the Worker.
 */

export interface SealLine {
  woNo: string;
  stationName: string;
  assetTag: string | null;
  categoryName: string | null;
  slaName: string | null;
  description: string;
  amountMinor: number;
}

export interface SealInput {
  lpoNo: string;
  version: number;
  contractorId: string;
  baseStationId: string | null;
  regionId: string | null;
  currency: string;
  subtotalMinor: number;
  mileageMinor: number;
  totalMinor: number;
  issuedAt: string; // ISO timestamp, exactly as stored
  lines: SealLine[];
}

const s = (v: string | null): string => v ?? '';

/**
 * The canonical string: a fixed-order JSON serialisation with the lines sorted by
 * wo_no. Object key order in JSON.stringify follows insertion order, so the fixed
 * literals below give a stable, unambiguous encoding.
 */
export function canonicalise(input: SealInput): string {
  const lines = [...input.lines]
    .sort((a, b) => (a.woNo < b.woNo ? -1 : a.woNo > b.woNo ? 1 : 0))
    .map((l) => ({
      wo_no: l.woNo,
      station_name: l.stationName,
      asset_tag: s(l.assetTag),
      category_name: s(l.categoryName),
      sla_name: s(l.slaName),
      description: l.description,
      amount_minor: Math.trunc(l.amountMinor),
    }));
  const document = {
    lpo_no: input.lpoNo,
    version: Math.trunc(input.version),
    contractor_id: input.contractorId,
    base_station_id: s(input.baseStationId),
    region_id: s(input.regionId),
    currency: input.currency,
    subtotal_minor: Math.trunc(input.subtotalMinor),
    mileage_minor: Math.trunc(input.mileageMinor),
    total_minor: Math.trunc(input.totalMinor),
    issued_at: input.issuedAt,
    lines,
  };
  return JSON.stringify(document);
}

/** The seal: sha256 over the canonical bytes, stored as "sha256:<hex>". */
export async function sealHash(input: SealInput): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalise(input));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}`;
}

export interface Reconciliation {
  ok: boolean;
  subtotalMinor: number; // sum of the line amounts
  expectedTotal: number; // subtotal + mileage
}

/**
 * Reconcile a total against its lines and mileage: the header total must equal
 * the sum of the frozen line amounts plus the approved mileage. Returns the
 * derived subtotal so the caller can set subtotal_minor from the same sum.
 */
export function reconcile(
  lines: ReadonlyArray<{ amountMinor: number }>,
  mileageMinor: number,
  totalMinor: number,
): Reconciliation {
  const subtotalMinor = lines.reduce((sum, l) => sum + Math.trunc(l.amountMinor), 0);
  const expectedTotal = subtotalMinor + Math.trunc(mileageMinor);
  return { ok: expectedTotal === Math.trunc(totalMinor), subtotalMinor, expectedTotal };
}
