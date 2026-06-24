export const prerender = false;

import type { APIRoute } from 'astro';
import { guard } from '@/lib/demo/guard';
import { json } from '@/lib/http';
import { crmContacts, type CrmStage } from '@/lib/demo/sample-data';

const STAGES: CrmStage[] = ['Lead', 'Qualified', 'Proposal', 'Won', 'Lost'];

interface ActivityEvent {
  type: 'email' | 'task' | 'audit';
  detail: string;
  at: string;
}

// Serve the starter pipeline (sample data) for the client to seed its state.
export const GET: APIRoute = async (context) => {
  const g = await guard(context, 'demo');
  if (g instanceof Response) return g;
  return json({ ok: true, contacts: crmContacts });
};

// Handle a stage change and run the bounded sample automation.
export const POST: APIRoute = async (context) => {
  const g = await guard(context, 'demo');
  if (g instanceof Response) return g;

  let body: Record<string, unknown> = {};
  try {
    body = (await context.request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const dealId = String(body.dealId ?? '').slice(0, 64);
  const name = String(body.name ?? 'a deal').slice(0, 120);
  const company = String(body.company ?? '').slice(0, 120);
  const toStage = String(body.toStage ?? '');
  if (!dealId || !STAGES.includes(toStage as CrmStage)) {
    return json({ ok: false, error: 'Invalid stage change.' }, 422);
  }

  const now = Date.now();
  const at = (ms: number) => new Date(now + ms).toISOString();
  const events: ActivityEvent[] = [];

  if (toStage === 'Won') {
    events.push({ type: 'email', detail: `Sample welcome email queued to ${name}.`, at: at(0) });
    events.push({
      type: 'task',
      detail: `Onboarding task created for ${company || name}.`,
      at: at(20),
    });
    events.push({
      type: 'audit',
      detail: `Deal ${dealId} moved to Won. Automation fired.`,
      at: at(40),
    });
  } else {
    events.push({ type: 'audit', detail: `Deal ${dealId} moved to ${toStage}.`, at: at(0) });
  }

  if (g.db) {
    try {
      for (const ev of events) {
        await g.db.execute({
          sql: 'INSERT INTO demo_crm_events (id, session_id, deal_id, type, payload_json) VALUES (?, ?, ?, ?, ?)',
          args: [crypto.randomUUID(), g.sessionId, dealId, ev.type, JSON.stringify(ev)],
        });
      }
    } catch {
      // best-effort
    }
  }

  return json({ ok: true, events });
};
