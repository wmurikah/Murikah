/**
 * The assistant: answers from this database, inside the asker's own scope.
 *
 * THE SCOPE IS NOT A PROMPT INSTRUCTION, AND THAT IS THE WHOLE DESIGN. Telling
 * a model "only mention records this user may see" is a wish. Every fact this
 * module puts in front of a model has already been read through the same
 * predicate the corresponding page uses, so a record outside the asker's scope
 * is not withheld by the model's good behaviour: it was never fetched, is not
 * in the prompt, and cannot be leaked by any wording of the question.
 *
 * A CONVERSATION ABOUT AN ENTITY IS CHECKED EXACTLY AS AN ACTIVITY IS. Not
 * similarly, exactly: it calls `resolveEntityAccess`, the same function
 * `activityAdmin` calls, which resolves the polymorphic (type, id) pair
 * against the real table and that module's own scope predicate. There is no
 * second implementation to drift.
 *
 * IT SAYS WHEN IT DOES NOT KNOW. The system instruction forbids inventing an
 * identifier, and the context it is given is explicit about what was searched
 * and what was found, so "no order matching that number is in your scope" is
 * an answer the model can give from the material rather than a refusal it has
 * to be talked into.
 *
 * WHAT IS RECORDED. The model, the input and output token counts and the
 * latency, on every message. Not for a dashboard: so the cost of this feature
 * is a number somebody can look up before the invoice arrives rather than
 * after.
 */
import type { Client } from '@libsql/client/web';
import { newId } from '../repos/authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';
import { resolveEntityAccess, isActivityEntityType } from '../crm/entityAccess.ts';
import { activeProvider } from './providers.ts';
import { callModel } from './model.ts';
import { scopedSalesOrders, SO_SOURCE } from '../repos/soPerformance.ts';
import { scopedCases } from '../repos/serviceAdmin.ts';

const text = (v: unknown): string => String(v ?? '');

/** How many turns of history travel with a question. */
const HISTORY_TURNS = 12;

/** How many rows of any one kind reach the prompt. */
const CONTEXT_ROWS = 10;

export const NO_PROVIDER =
  'No assistant is configured. An administrator can set one up under Administration.';

export const OUT_OF_SCOPE =
  'That record is not one you can open, so I cannot discuss it.';

/**
 * The standing instruction.
 *
 * IT NAMES THE ONE FAILURE THAT MATTERS. A model that invents an order number
 * is worse than a model that says nothing, because the invented number looks
 * exactly like a real one and somebody will act on it.
 */
export const SYSTEM_PROMPT = [
  'You are the assistant inside a petroleum distributor’s customer operations system.',
  'Answer only from the records given to you below. They have already been filtered to what',
  'this person is allowed to see.',
  '',
  'If the records do not contain the answer, say so plainly and say what you looked at.',
  'Never invent an order number, an invoice number, a customer name, a date or a figure.',
  'If you are asked about a record that is not in the material, say it is not in the records',
  'available to you rather than guessing what it might contain.',
  '',
  'Be brief. Give the figure and where it came from.',
].join('\n');

export interface Conversation {
  readonly botConversationId: string;
  readonly userId: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly title: string | null;
}

export interface AskResult {
  readonly ok: boolean;
  /** What the person is shown, whatever happened. */
  readonly answer: string;
  readonly conversationId: string | null;
  /** Present when a model actually answered. */
  readonly usage: {
    readonly model: string;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly latencyMs: number;
  } | null;
}

/**
 * Start a conversation, checking the entity first where there is one.
 *
 * The check happens BEFORE the row is written, so a conversation about a
 * record the asker cannot open does not exist to be resumed later.
 */
export async function startConversation(
  db: Client,
  userId: string,
  input: { entityType?: string | null; entityId?: string | null; title?: string | null },
  ctx: WriteContext,
): Promise<{ ok: true; conversationId: string } | { ok: false; reason: string }> {
  const entityType = input.entityType ?? null;
  const entityId = input.entityId ?? null;

  if (entityType !== null && entityId !== null) {
    if (!isActivityEntityType(entityType)) return { ok: false, reason: OUT_OF_SCOPE };
    // EXACTLY AS AN ACTIVITY DOES. Same function, same predicate, same answer.
    const access = await resolveEntityAccess(db, userId, entityType, entityId);
    if (!access.ok) return { ok: false, reason: OUT_OF_SCOPE };
  }

  const id = newId('BCV');
  await db.execute({
    sql: `INSERT INTO bot_conversations
            (bot_conversation_id, user_id, ai_provider_id, title, entity_type, entity_id,
             status, started_at, last_message_at)
          VALUES (?, ?, NULL, ?, ?, ?, 'OPEN', ?, NULL)`,
    args: [id, userId, input.title ?? null, entityType, entityId, toDbTimestamp(ctx.now)],
  });
  return { ok: true, conversationId: id };
}

/**
 * The conversation, if it belongs to this person.
 *
 * OWNERSHIP IS THE PREDICATE, not a filter applied afterwards. A conversation
 * belongs to one user; asking for somebody else's by id returns nothing rather
 * than returning it and hiding it later.
 */
export async function ownedConversation(
  db: Client,
  userId: string,
  conversationId: string,
): Promise<Conversation | null> {
  const found = await db.execute({
    sql: `SELECT bot_conversation_id, user_id, entity_type, entity_id, title
            FROM bot_conversations WHERE bot_conversation_id = ? AND user_id = ?`,
    args: [conversationId, userId],
  });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    botConversationId: text(row.bot_conversation_id),
    userId: text(row.user_id),
    entityType: row.entity_type === null ? null : text(row.entity_type),
    entityId: row.entity_id === null ? null : text(row.entity_id),
    title: row.title === null ? null : text(row.title),
  };
}

export interface StoredMessage {
  readonly role: string;
  readonly content: string;
  readonly sequenceNo: number;
}

export async function conversationMessages(
  db: Client,
  conversationId: string,
): Promise<StoredMessage[]> {
  const found = await db.execute({
    sql: `SELECT role, content, sequence_no FROM bot_messages
           WHERE bot_conversation_id = ? ORDER BY sequence_no DESC LIMIT ?`,
    args: [conversationId, HISTORY_TURNS],
  });
  return found.rows
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        role: text(row.role),
        content: text(row.content),
        sequenceNo: Number(row.sequence_no ?? 0),
      };
    })
    .reverse();
}

/**
 * The records the question is answered from, every one already scoped.
 *
 * TWO READS, BOTH THROUGH THE MODULE'S OWN PREDICATE. `scopedSalesOrders` and
 * `scopedCases` are the same functions the sales order list and the helpdesk
 * queue use; this asks them for a handful of recent rows rather than
 * re-deriving what the asker may see. Anything the predicate excludes is not
 * in the returned text at all.
 *
 * Deliberately small. A prompt carrying five hundred rows costs tokens on
 * every turn and answers no better than one carrying ten: the assistant is for
 * "where is order 4471" and "how many cases are open on this account", not for
 * analysis, which is what the dashboards are.
 */
export async function scopedContext(
  db: Client,
  userId: string,
  entity: { entityType: string | null; entityId: string | null },
): Promise<string> {
  const parts: string[] = [];

  if (entity.entityType !== null && entity.entityId !== null) {
    parts.push(`This conversation is about ${entity.entityType} ${entity.entityId}.`);
  }

  const orders = await scopedSalesOrders(db, userId);
  const cases = await scopedCases(db, userId);

  // SO_SOURCE, NOT A JOIN WRITTEN HERE. The predicate names `af.country_id`
  // and `ac.account_id`; a query that joined the same tables under different
  // aliases would fail at runtime, and one that dropped the affiliate join
  // would silently answer a country-scoped user with nothing.
  const orderRows = await db.execute({
    sql: `SELECT so.document_number, so.status, so.order_created_at, so.invoice_number,
                 ac.account_name
            FROM ${SO_SOURCE}
           WHERE ${orders.sql}
           ORDER BY so.order_created_at DESC LIMIT ?`,
    args: [...(orders.args as never[]), CONTEXT_ROWS],
  });
  parts.push(
    orderRows.rows.length === 0
      ? 'Sales orders in your scope: none found.'
      : 'Recent sales orders in your scope:\n' +
          orderRows.rows
            .map((raw) => {
              const r = raw as Record<string, unknown>;
              return `- ${text(r.document_number)} for ${text(r.account_name)}, ${text(r.status)}, raised ${text(r.order_created_at)}, invoice ${text(r.invoice_number) || 'none'}`;
            })
            .join('\n'),
  );

  const caseRows = await db.execute({
    sql: `SELECT sc.case_number, sc.subject, sc.status, sc.priority
            FROM service_cases sc
            JOIN accounts a ON a.account_id = sc.account_id
           WHERE ${cases.sql}
           ORDER BY sc.raised_at DESC LIMIT ?`,
    args: [...(cases.args as never[]), CONTEXT_ROWS],
  });
  parts.push(
    caseRows.rows.length === 0
      ? 'Helpdesk cases in your scope: none found.'
      : 'Recent helpdesk cases in your scope:\n' +
          caseRows.rows
            .map((raw) => {
              const r = raw as Record<string, unknown>;
              return `- ${text(r.case_number)}: ${text(r.subject)} (${text(r.status)}, ${text(r.priority)})`;
            })
            .join('\n'),
  );

  return parts.join('\n\n');
}

/**
 * Ask, record, and answer.
 *
 * BOTH MESSAGES ARE WRITTEN WHATEVER HAPPENS, including when the provider
 * refused. A conversation whose failed turns are missing reads as though the
 * question was never asked, and the token counts on the successful turns then
 * under-report what the feature cost.
 */
export async function ask(
  db: Client,
  userId: string,
  conversationId: string,
  question: string,
  env: Record<string, unknown>,
  ctx: WriteContext,
): Promise<AskResult> {
  const conversation = await ownedConversation(db, userId, conversationId);
  if (conversation === null) {
    return { ok: false, answer: OUT_OF_SCOPE, conversationId: null, usage: null };
  }

  // RE-CHECKED ON EVERY TURN, not only when the conversation was started. A
  // person's scope can be narrowed between two questions, and a conversation
  // opened yesterday must not keep answering about a record they lost access
  // to this morning.
  if (conversation.entityType !== null && conversation.entityId !== null) {
    const access = await resolveEntityAccess(
      db,
      userId,
      conversation.entityType as never,
      conversation.entityId,
    );
    if (!access.ok) {
      return { ok: false, answer: OUT_OF_SCOPE, conversationId, usage: null };
    }
  }

  const provider = await activeProvider(db, 'ASSISTANT');
  const history = await conversationMessages(db, conversationId);
  const nextSequence = (history[history.length - 1]?.sequenceNo ?? 0) + 1;
  const now = toDbTimestamp(ctx.now);

  const writeMessage = async (
    sequenceNo: number,
    role: string,
    content: string,
    usage: {
      model: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      latencyMs: number | null;
    },
  ): Promise<void> => {
    await db.execute({
      sql: `INSERT INTO bot_messages
              (bot_message_id, bot_conversation_id, sequence_no, role, content, model,
               input_tokens, output_tokens, latency_ms, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('BMS'),
        conversationId,
        sequenceNo,
        role,
        content,
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        usage.latencyMs,
        now,
      ],
    });
  };

  await writeMessage(nextSequence, 'USER', question, {
    model: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
  });

  if (provider === null) {
    await writeMessage(nextSequence + 1, 'ASSISTANT', NO_PROVIDER, {
      model: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
    });
    await touch(db, conversationId, now);
    return { ok: false, answer: NO_PROVIDER, conversationId, usage: null };
  }

  const context = await scopedContext(db, userId, conversation);
  const answer = await callModel(provider, env, {
    system: `${SYSTEM_PROMPT}\n\n---\nRecords available to this person:\n\n${context}`,
    messages: [
      ...history.map((m) => ({
        role: m.role === 'ASSISTANT' ? ('assistant' as const) : ('user' as const),
        content: m.content,
      })),
      { role: 'user' as const, content: question },
    ],
  });

  const reply =
    answer.status === 'OK' && answer.content.trim() !== ''
      ? answer.content.trim()
      : 'I could not reach the assistant just now. Nothing was changed.';

  await writeMessage(nextSequence + 1, 'ASSISTANT', reply, {
    model: answer.model,
    inputTokens: answer.inputTokens,
    outputTokens: answer.outputTokens,
    latencyMs: answer.latencyMs,
  });
  await db.execute({
    sql: `UPDATE bot_conversations SET ai_provider_id = ?, last_message_at = ?
           WHERE bot_conversation_id = ?`,
    args: [provider.aiProviderId, now, conversationId],
  });

  return {
    ok: answer.status === 'OK',
    answer: reply,
    conversationId,
    usage: {
      model: answer.model,
      inputTokens: answer.inputTokens,
      outputTokens: answer.outputTokens,
      latencyMs: answer.latencyMs,
    },
  };
}

async function touch(db: Client, conversationId: string, now: string): Promise<void> {
  await db.execute({
    sql: `UPDATE bot_conversations SET last_message_at = ? WHERE bot_conversation_id = ?`,
    args: [now, conversationId],
  });
}
