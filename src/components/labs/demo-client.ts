/** Small client helpers shared by the Labs demo islands. */

export interface ApiResult<T> {
  status: number;
  data: T & { ok?: boolean; error?: string };
}

export async function getJson<T = Record<string, unknown>>(url: string): Promise<ApiResult<T>> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  return { status: res.status, data };
}

export async function postJson<T = Record<string, unknown>>(
  url: string,
  body: unknown,
): Promise<ApiResult<T>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  return { status: res.status, data };
}

/** Format a whole-shilling KES amount. */
export function kes(n: number): string {
  return new Intl.NumberFormat('en-KE', {
    style: 'currency',
    currency: 'KES',
    maximumFractionDigits: 0,
  }).format(n);
}

/** Trigger a client-side CSV download from a string. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Format an ISO timestamp as HH:MM:SS for the audit-log panels. */
export function clock(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-GB');
  } catch {
    return iso;
  }
}
