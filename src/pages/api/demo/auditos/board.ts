export const prerender = false;

import type { APIRoute } from 'astro';
import { guard } from '@/lib/demo/guard';
import { json } from '@/lib/http';
import { boardItems } from '@/lib/demo/sample-data';

export const GET: APIRoute = async (context) => {
  const g = await guard(context, 'demo');
  if (g instanceof Response) return g;
  return json({ ok: true, items: boardItems });
};
