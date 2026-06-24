/**
 * Document extraction logic. Sample invoices are extracted deterministically
 * from known data, so the demo always works with zero cost and no provider key.
 * Uploaded files (optional) go to the model, and the model's output is always
 * validated and coerced against this schema before it is shown. Raw model text
 * is never displayed.
 */
import { invoiceById } from './sample-data';

export interface ExtractedInvoice {
  supplier: string;
  number: string;
  date: string;
  currency: string;
  lineItems: { description: string; qty: number; unitPrice: number; amount: number }[];
  subtotal: number;
  tax: number;
  total: number;
}

/** The instruction handed to the model for uploaded documents. */
export const EXTRACT_INSTRUCTION =
  'Extract the invoice as strict JSON with exactly these keys: supplier (string), number (string), date (string), currency (string), lineItems (array of { description, qty, unitPrice, amount }), subtotal (number), tax (number), total (number). Return only the JSON, no prose.';

export function extractSample(id: string): ExtractedInvoice | null {
  const inv = invoiceById(id);
  if (!inv) return null;
  return {
    supplier: inv.supplier,
    number: inv.number,
    date: inv.date,
    currency: inv.currency,
    lineItems: inv.lineItems,
    subtotal: inv.subtotal,
    tax: inv.tax,
    total: inv.total,
  };
}

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
}

/** Validate and coerce arbitrary (model) output into the strict schema. */
export function validateExtracted(
  input: unknown,
): { ok: true; value: ExtractedInvoice } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Could not read the document. Please try a sample invoice.' };
  }
  const o = input as Record<string, unknown>;
  const rawItems = Array.isArray(o.lineItems) ? o.lineItems : [];
  const lineItems = rawItems.slice(0, 50).map((it) => {
    const r = (it ?? {}) as Record<string, unknown>;
    return {
      description: str(r.description).slice(0, 200),
      qty: num(r.qty),
      unitPrice: num(r.unitPrice),
      amount: num(r.amount),
    };
  });

  const value: ExtractedInvoice = {
    supplier: str(o.supplier).slice(0, 200),
    number: str(o.number).slice(0, 80),
    date: str(o.date).slice(0, 40),
    currency: (str(o.currency) || 'KES').slice(0, 8),
    lineItems,
    subtotal: num(o.subtotal),
    tax: num(o.tax),
    total: num(o.total),
  };

  if (!value.supplier && value.lineItems.length === 0 && !value.total) {
    return { ok: false, error: 'Could not read the document. Please try a sample invoice.' };
  }
  return { ok: true, value };
}

/** Try to pull a JSON object out of a model reply, then validate it. */
export function parseModelExtraction(text: string) {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false as const, error: 'Could not read the document.' };
    try {
      candidate = JSON.parse(match[0]);
    } catch {
      return { ok: false as const, error: 'Could not read the document.' };
    }
  }
  return validateExtracted(candidate);
}

/** Build a clean CSV for download. */
export function toCsv(e: ExtractedInvoice): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows: string[][] = [
    ['Field', 'Value'],
    ['Supplier', e.supplier],
    ['Invoice number', e.number],
    ['Date', e.date],
    ['Currency', e.currency],
    [],
    ['Description', 'Quantity', 'Unit price', 'Amount'],
    ...e.lineItems.map((li) => [
      li.description,
      String(li.qty),
      String(li.unitPrice),
      String(li.amount),
    ]),
    [],
    ['Subtotal', String(e.subtotal)],
    ['Tax', String(e.tax)],
    ['Total', String(e.total)],
  ];
  return rows.map((r) => r.map((c) => esc(c ?? '')).join(',')).join('\n');
}
