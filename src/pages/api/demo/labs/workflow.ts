export const prerender = false;

import type { APIRoute } from 'astro';
import { guard } from '@/lib/demo/guard';
import { json } from '@/lib/http';
import { validateDefinition, evaluateWorkflow } from '@/lib/demo/workflow';

export const POST: APIRoute = async (context) => {
  const g = await guard(context, 'demo');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try {
    body = (await context.request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const parsed = validateDefinition(body.definition);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 422);

  const result = evaluateWorkflow(parsed.value, new Date());

  if (g.db) {
    try {
      await g.db.execute({
        sql: 'INSERT INTO demo_workflow_runs (id, session_id, definition_json, event_json, result_json, log_json) VALUES (?, ?, ?, ?, ?, ?)',
        args: [
          crypto.randomUUID(),
          g.sessionId,
          JSON.stringify(parsed.value),
          JSON.stringify(result.event),
          JSON.stringify({ conditionMet: result.conditionMet, firedActions: result.firedActions }),
          JSON.stringify(result.log),
        ],
      });
    } catch {
      // best-effort
    }
  }

  return json({ ok: true, result });
};
