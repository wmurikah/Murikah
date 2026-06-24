export const prerender = false;

import type { APIRoute } from 'astro';
import { guard } from '@/lib/demo/guard';
import { json } from '@/lib/http';
import { findingByRef, workpaperFor } from '@/lib/demo/sample-data';

export const GET: APIRoute = async (context) => {
  const g = await guard(context, 'demo');
  if (g instanceof Response) return g;

  const ref = context.params.ref ?? '';
  const finding = findingByRef(ref);
  if (!finding) {
    return json({ ok: false, error: 'Finding not found.' }, 404);
  }
  return json({ ok: true, finding, workpaper: workpaperFor(ref) ?? null });
};
