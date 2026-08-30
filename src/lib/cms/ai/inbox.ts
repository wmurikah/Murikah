/**
 * Messages in, a suggestion beside each one, and a person between the
 * suggestion and the record.
 *
 * WRITTEN ONCE, WHATEVER THE TRANSPORT DOES. `UNIQUE(channel_connection_id,
 * external_message_id)` is what makes a repeated poll and a retried webhook
 * safe, and the insert leans on it rather than checking first: a SELECT then
 * an INSERT is two statements with a race between them, and the race is
 * exactly the double-delivery this is meant to survive. `ON CONFLICT DO
 * NOTHING` is one statement and the database decides. It is the same idea as
 * the file hash on an import, applied to a message.
 *
 * THE MODEL SUGGESTS, A PERSON DECIDES. A classification sits at PENDING
 * carrying what the model thought, its confidence and its reason. Accepting,
 * correcting or rejecting writes the decision BESIDE the suggestion rather
 * than over it, which is what lets somebody ask later whether the model is any
 * good, and what stops a confident wrong guess becoming the record.
 *
 * AN UNREVIEWED SUGGESTION NEVER BECOMES A CASE. The only paths that create
 * one are a person's review and, where an administrator has explicitly turned
 * `auto_create_case` on, a confidence at or above the stated threshold. Even
 * then the suggestion is still recorded, so the automatic decision is as
 * auditable as the human one.
 *
 * NOTHING IS SENT TO A MODEL WITHOUT AN ACTIVE PROVIDER. A customer's words
 * leave this system only when an administrator has configured somewhere for
 * them to go and switched it on. With no provider the message still lands, at
 * RECEIVED with no classification, and the queue says why.
 */
import type { Client } from '@libsql/client/web';
import { newId } from '../repos/authRecords.ts';
import { toDbTimestamp } from '../auth/session.ts';
import type { WriteContext } from '../admin/guard.ts';
import { activeProvider } from './providers.ts';
import { callModel } from './model.ts';
import { getConnection } from './channels.ts';
import { createCase } from '../repos/serviceAdmin.ts';

const text = (v: unknown): string => String(v ?? '');
const maybeText = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const maybeNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * The confidence at or above which a connection with `auto_create_case` on
 * opens a case without a person.
 *
 * 0.85, and the number is here rather than in a column because it is a policy
 * about how much this organisation trusts a model, not a per-connection
 * setting somebody should be able to lower to 0.2 on a Friday. Below it, the
 * suggestion waits in the queue exactly as it would if the switch were off.
 */
export const AUTO_CASE_CONFIDENCE = 0.85;

export const CASE_TYPES = [
  'ENQUIRY',
  'COMPLAINT',
  'REQUEST',
  'INCIDENT',
  'FEEDBACK',
  'COMPLIMENT',
] as const;
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const REVIEW_STATUSES = ['PENDING', 'ACCEPTED', 'CORRECTED', 'REJECTED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const NO_PROVIDER_NOTE = 'No classifier is configured, so messages are queued unclassified.';

export interface IncomingMessage {
  readonly channelConnectionId: string;
  readonly externalMessageId: string;
  readonly fromAddress: string | null;
  readonly toAddress: string | null;
  readonly subject: string | null;
  readonly body: string | null;
  readonly receivedAt: string;
  readonly raw?: unknown;
}

export interface IngestResult {
  readonly channelMessageId: string | null;
  /** False where this exact message was already stored. */
  readonly stored: boolean;
}

/**
 * Store one inbound message, or do nothing because it is already here.
 *
 * ONE STATEMENT. The `ON CONFLICT` clause names the unique constraint, so a
 * second delivery of the same external id is a no-op decided by the database
 * rather than by a check this code performs and a competing request invalidates
 * a microsecond later.
 */
export async function ingestMessage(db: Client, message: IncomingMessage): Promise<IngestResult> {
  const id = newId('CHM');
  await db.execute({
    sql: `INSERT INTO channel_messages
            (channel_message_id, channel_connection_id, external_message_id, direction,
             from_address, to_address, subject, body, received_at, status, raw_json)
          VALUES (?, ?, ?, 'INBOUND', ?, ?, ?, ?, ?, 'RECEIVED', ?)
          ON CONFLICT(channel_connection_id, external_message_id) DO NOTHING`,
    args: [
      id,
      message.channelConnectionId,
      message.externalMessageId,
      message.fromAddress,
      message.toAddress,
      message.subject,
      message.body,
      message.receivedAt,
      message.raw === undefined ? null : JSON.stringify(message.raw),
    ],
  });

  // WHICH ROW WON. The insert may have been the no-op, so the id that matters
  // is whatever the table holds for this pair, not the one just minted.
  const found = await db.execute({
    sql: `SELECT channel_message_id FROM channel_messages
           WHERE channel_connection_id = ? AND external_message_id = ?`,
    args: [message.channelConnectionId, message.externalMessageId],
  });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  const storedId = row === undefined ? null : text(row.channel_message_id);
  return { channelMessageId: storedId, stored: storedId === id };
}

export interface Suggestion {
  readonly caseType: string | null;
  readonly categoryId: string | null;
  readonly priority: string | null;
  readonly accountId: string | null;
  readonly confidence: number | null;
  readonly rationale: string | null;
}

/**
 * The instruction, and the shape the answer must take.
 *
 * The model is given the categories and accounts that exist and told to choose
 * from them or choose nothing, because a category it invents cannot be stored:
 * `message_classifications.suggested_case_category_id` is a foreign key.
 */
function classificationPrompt(
  categories: { id: string; name: string }[],
  accounts: { id: string; name: string }[],
): string {
  return [
    'Classify one inbound customer message for a petroleum distributor’s helpdesk.',
    '',
    'Answer with JSON only, no prose, in exactly this shape:',
    '{"caseType":…,"categoryId":…,"priority":…,"accountId":…,"confidence":…,"rationale":…}',
    '',
    `caseType is one of ${CASE_TYPES.join(', ')} or null.`,
    `priority is one of ${PRIORITIES.join(', ')} or null.`,
    'confidence is a number from 0 to 1 and must reflect real uncertainty.',
    'rationale is one short sentence saying what in the message decided it.',
    '',
    'categoryId must be one of these ids, or null:',
    ...categories.map((c) => `  ${c.id} = ${c.name}`),
    '',
    'accountId must be one of these ids, or null:',
    ...accounts.map((a) => `  ${a.id} = ${a.name}`),
    '',
    'Choose null rather than guessing. A low confidence with null fields is a',
    'better answer than a confident invention.',
  ].join('\n');
}

/** The model's JSON, kept only where each field is one the database allows. */
export function parseSuggestion(
  raw: string,
  categoryIds: ReadonlySet<string>,
  accountIds: ReadonlySet<string>,
): Suggestion {
  const empty: Suggestion = {
    caseType: null,
    categoryId: null,
    priority: null,
    accountId: null,
    confidence: null,
    rationale: null,
  };
  // A model asked for JSON sometimes wraps it in a fence. Take the outermost
  // object rather than refusing an answer that is correct inside a wrapper.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return empty;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return empty;
  }
  const oneOf = (value: unknown, allowed: readonly string[]): string | null =>
    typeof value === 'string' && allowed.includes(value) ? value : null;
  const known = (value: unknown, ids: ReadonlySet<string>): string | null =>
    typeof value === 'string' && ids.has(value) ? value : null;
  const confidence =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : null;
  return {
    caseType: oneOf(parsed.caseType, CASE_TYPES),
    categoryId: known(parsed.categoryId, categoryIds),
    priority: oneOf(parsed.priority, PRIORITIES),
    accountId: known(parsed.accountId, accountIds),
    confidence,
    rationale:
      typeof parsed.rationale === 'string' && parsed.rationale.trim() !== ''
        ? parsed.rationale.trim().slice(0, 400)
        : null,
  };
}

export interface ClassifyOutcome {
  readonly classified: boolean;
  /** Why not, where it was not. */
  readonly reason: string | null;
  readonly classificationId: string | null;
  readonly caseId: string | null;
}

/**
 * Classify one stored message, and open a case only where policy allows it.
 *
 * The provider is looked up FIRST and the message body is not read from the
 * row until there is somewhere to send it: with no active provider nothing
 * leaves this system, which is the criterion, and the early return is what
 * makes that true by construction rather than by a check further down that
 * somebody later reorders.
 */
export async function classifyMessage(
  db: Client,
  channelMessageId: string,
  env: Record<string, unknown>,
  ctx: WriteContext,
): Promise<ClassifyOutcome> {
  const provider = await activeProvider(db, 'CLASSIFICATION');
  if (provider === null) {
    return {
      classified: false,
      reason: NO_PROVIDER_NOTE,
      classificationId: null,
      caseId: null,
    };
  }

  const found = await db.execute({
    sql: `SELECT channel_message_id, channel_connection_id, from_address, subject, body, status
            FROM channel_messages WHERE channel_message_id = ?`,
    args: [channelMessageId],
  });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    return { classified: false, reason: 'No such message.', classificationId: null, caseId: null };
  }

  const [categoryRows, accountRows] = await Promise.all([
    db.execute(
      `SELECT case_category_id AS id, category_name AS name FROM case_categories
        WHERE active = 1 ORDER BY category_name LIMIT 60`,
    ),
    db.execute(
      `SELECT account_id AS id, account_name AS name FROM accounts
        WHERE status = 'ACTIVE' ORDER BY account_name LIMIT 200`,
    ),
  ]);
  const categories = categoryRows.rows.map((r) => ({
    id: text((r as Record<string, unknown>).id),
    name: text((r as Record<string, unknown>).name),
  }));
  const accounts = accountRows.rows.map((r) => ({
    id: text((r as Record<string, unknown>).id),
    name: text((r as Record<string, unknown>).name),
  }));

  const answer = await callModel(provider, env, {
    system: classificationPrompt(categories, accounts),
    messages: [
      {
        role: 'user',
        content: [
          `From: ${text(row.from_address) || 'unknown'}`,
          `Subject: ${text(row.subject) || 'none'}`,
          '',
          text(row.body),
        ].join('\n'),
      },
    ],
    maxOutputTokens: 400,
  });

  if (answer.status !== 'OK') {
    await db.execute({
      sql: `UPDATE channel_messages SET status = 'FAILED' WHERE channel_message_id = ?`,
      args: [channelMessageId],
    });
    return {
      classified: false,
      reason: 'The classifier could not be reached.',
      classificationId: null,
      caseId: null,
    };
  }

  const suggestion = parseSuggestion(
    answer.content,
    new Set(categories.map((c) => c.id)),
    new Set(accounts.map((a) => a.id)),
  );

  const classificationId = newId('MCL');
  const now = toDbTimestamp(ctx.now);
  await db.execute({
    sql: `INSERT INTO message_classifications
            (message_classification_id, channel_message_id, ai_provider_id, model,
             suggested_case_type, suggested_case_category_id, suggested_priority,
             suggested_account_id, confidence, rationale, review_status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
          ON CONFLICT(channel_message_id) DO NOTHING`,
    args: [
      classificationId,
      channelMessageId,
      provider.aiProviderId,
      answer.model,
      suggestion.caseType,
      suggestion.categoryId,
      suggestion.priority,
      suggestion.accountId,
      suggestion.confidence,
      suggestion.rationale,
      now,
    ],
  });
  await db.execute({
    sql: `UPDATE channel_messages SET status = 'CLASSIFIED' WHERE channel_message_id = ?`,
    args: [channelMessageId],
  });

  // AUTOMATIC CASE CREATION, AND ONLY WHERE BOTH GATES OPEN. The connection
  // must have been switched on by an administrator AND the model must be at
  // least AUTO_CASE_CONFIDENCE sure. The suggestion is recorded either way, so
  // an automatic decision is as reviewable afterwards as a human one.
  const connection = await getConnection(db, text(row.channel_connection_id));
  const confident = (suggestion.confidence ?? 0) >= AUTO_CASE_CONFIDENCE;
  if (
    connection !== null &&
    connection.autoCreateCase &&
    confident &&
    suggestion.accountId !== null
  ) {
    const caseId = await openCase(
      db,
      channelMessageId,
      classificationId,
      {
        accountId: suggestion.accountId,
        caseType: suggestion.caseType ?? 'ENQUIRY',
        categoryId: suggestion.categoryId ?? connection.defaultCaseCategoryId,
        priority: suggestion.priority,
        subject: text(row.subject) || 'Message from a customer',
        description: text(row.body),
        channel: connection.channel,
      },
      ctx,
      'ACCEPTED',
    );
    return { classified: true, reason: null, classificationId, caseId };
  }

  return { classified: true, reason: null, classificationId, caseId: null };
}

/**
 * Open the case a decision calls for, and link the message to it.
 *
 * `createCase` is the module's own function, so a case born from a message is
 * indistinguishable from one raised at a desk: same validation, same audit,
 * same SLA wiring.
 */
async function openCase(
  db: Client,
  channelMessageId: string,
  classificationId: string,
  input: {
    accountId: string;
    caseType: string;
    categoryId: string | null;
    priority: string | null;
    subject: string;
    description: string;
    channel: string;
  },
  ctx: WriteContext,
  reviewStatus: ReviewStatus,
): Promise<string | null> {
  if (input.categoryId === null) return null;
  const created = await createCase(
    db,
    ctx.actorUserId,
    {
      accountId: input.accountId,
      contactId: null,
      businessUnitId: null,
      caseType: input.caseType,
      caseCategoryId: input.categoryId,
      priority: input.priority,
      subject: input.subject.slice(0, 200),
      description: input.description === '' ? 'No message body was supplied.' : input.description,
      channel: input.channel === 'WHATSAPP' ? 'WHATSAPP' : 'EMAIL',
      raisedAt: toDbTimestamp(ctx.now),
      assignedTeamId: null,
      assignedUserId: null,
    },
    ctx,
    // The priority came from a suggestion a person accepted or from the
    // category's own default; either way this call is allowed to set it.
    true,
  );
  if (!created.ok) return null;
  const caseId = created.value.caseId;
  await db.execute({
    sql: `UPDATE channel_messages SET case_id = ?, status = 'LINKED'
           WHERE channel_message_id = ?`,
    args: [caseId, channelMessageId],
  });
  await db.execute({
    sql: `UPDATE message_classifications
             SET review_status = ?, final_case_type = ?, final_case_category_id = ?,
                 final_priority = ?
           WHERE message_classification_id = ?`,
    args: [reviewStatus, input.caseType, input.categoryId, input.priority, classificationId],
  });
  return caseId;
}

export interface ReviewDecision {
  readonly action: 'ACCEPT' | 'CORRECT' | 'REJECT';
  /** Supplied on a correction; ignored otherwise. */
  readonly caseType?: string | null;
  readonly categoryId?: string | null;
  readonly priority?: string | null;
  readonly accountId?: string | null;
}

export interface ReviewOutcome {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly caseId: string | null;
  readonly reviewStatus: ReviewStatus | null;
}

/**
 * A person's decision on one suggestion.
 *
 * BOTH ARE KEPT. The suggested columns are never overwritten; the decision goes
 * into the final columns beside them. That is what makes "is the model any
 * good" a query rather than an opinion, and it is why a correction is a
 * distinct status from an acceptance: the difference between them is the
 * measure.
 */
export async function reviewClassification(
  db: Client,
  classificationId: string,
  decision: ReviewDecision,
  ctx: WriteContext,
): Promise<ReviewOutcome> {
  const found = await db.execute({
    sql: `SELECT mc.message_classification_id, mc.channel_message_id, mc.review_status,
                 mc.suggested_case_type, mc.suggested_case_category_id, mc.suggested_priority,
                 mc.suggested_account_id,
                 cm.subject, cm.body, cm.channel_connection_id
            FROM message_classifications mc
            JOIN channel_messages cm ON cm.channel_message_id = mc.channel_message_id
           WHERE mc.message_classification_id = ?`,
    args: [classificationId],
  });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    return { ok: false, reason: 'No such suggestion.', caseId: null, reviewStatus: null };
  }
  if (text(row.review_status) !== 'PENDING') {
    return {
      ok: false,
      reason: 'That suggestion has already been reviewed.',
      caseId: null,
      reviewStatus: text(row.review_status) as ReviewStatus,
    };
  }

  const now = toDbTimestamp(ctx.now);

  if (decision.action === 'REJECT') {
    await db.execute({
      sql: `UPDATE message_classifications
               SET review_status = 'REJECTED', reviewed_by_user_id = ?, reviewed_at = ?
             WHERE message_classification_id = ?`,
      args: [ctx.actorUserId, now, classificationId],
    });
    await db.execute({
      sql: `UPDATE channel_messages SET status = 'IGNORED' WHERE channel_message_id = ?`,
      args: [text(row.channel_message_id)],
    });
    return { ok: true, reason: null, caseId: null, reviewStatus: 'REJECTED' };
  }

  const corrected = decision.action === 'CORRECT';
  const caseType = (corrected ? decision.caseType : null) ?? maybeText(row.suggested_case_type);
  const categoryId =
    (corrected ? decision.categoryId : null) ?? maybeText(row.suggested_case_category_id);
  const priority = (corrected ? decision.priority : null) ?? maybeText(row.suggested_priority);
  const accountId = (corrected ? decision.accountId : null) ?? maybeText(row.suggested_account_id);

  if (accountId === null || categoryId === null) {
    return {
      ok: false,
      reason: 'Choose the customer and the category before accepting.',
      caseId: null,
      reviewStatus: null,
    };
  }

  const connection = await getConnection(db, text(row.channel_connection_id));
  await db.execute({
    sql: `UPDATE message_classifications
             SET reviewed_by_user_id = ?, reviewed_at = ?
           WHERE message_classification_id = ?`,
    args: [ctx.actorUserId, now, classificationId],
  });
  const caseId = await openCase(
    db,
    text(row.channel_message_id),
    classificationId,
    {
      accountId,
      caseType: caseType ?? 'ENQUIRY',
      categoryId,
      priority,
      subject: text(row.subject) || 'Message from a customer',
      description: text(row.body),
      channel: connection?.channel ?? 'EMAIL',
    },
    ctx,
    corrected ? 'CORRECTED' : 'ACCEPTED',
  );
  if (caseId === null) {
    return {
      ok: false,
      reason: 'The case could not be created. Nothing was changed.',
      caseId: null,
      reviewStatus: null,
    };
  }
  return {
    ok: true,
    reason: null,
    caseId,
    reviewStatus: corrected ? 'CORRECTED' : 'ACCEPTED',
  };
}

export interface QueueRow {
  readonly channelMessageId: string;
  readonly classificationId: string | null;
  readonly connectionName: string;
  readonly channel: string;
  readonly fromAddress: string | null;
  readonly subject: string | null;
  readonly body: string | null;
  readonly receivedAt: string;
  readonly status: string;
  readonly suggestedCaseType: string | null;
  readonly suggestedCategory: string | null;
  readonly suggestedPriority: string | null;
  readonly suggestedAccount: string | null;
  readonly confidence: number | null;
  readonly rationale: string | null;
  readonly reviewStatus: string | null;
}

/**
 * The review queue: everything still waiting on a person. One round trip.
 *
 * A message with no classification row appears too, because "nothing has been
 * suggested for this yet" is the state a queue with no active provider is
 * entirely made of, and a queue that hid those would look empty while filling
 * up.
 */
export async function reviewQueue(db: Client, limit = 100): Promise<QueueRow[]> {
  const found = await db.execute({
    sql: `SELECT cm.channel_message_id, cm.from_address, cm.subject, cm.body, cm.received_at,
                 cm.status, cc.display_name AS connection_name, cc.channel,
                 mc.message_classification_id, mc.suggested_case_type, mc.suggested_priority,
                 mc.confidence, mc.rationale, mc.review_status,
                 cat.category_name AS suggested_category, a.account_name AS suggested_account
            FROM channel_messages cm
            JOIN channel_connections cc
              ON cc.channel_connection_id = cm.channel_connection_id
            LEFT JOIN message_classifications mc
              ON mc.channel_message_id = cm.channel_message_id
            LEFT JOIN case_categories cat
              ON cat.case_category_id = mc.suggested_case_category_id
            LEFT JOIN accounts a ON a.account_id = mc.suggested_account_id
           WHERE cm.direction = 'INBOUND'
             AND cm.case_id IS NULL
             AND (mc.review_status IS NULL OR mc.review_status = 'PENDING')
           ORDER BY cm.received_at DESC
           LIMIT ?`,
    args: [limit],
  });
  return found.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      channelMessageId: text(row.channel_message_id),
      classificationId: maybeText(row.message_classification_id),
      connectionName: text(row.connection_name),
      channel: text(row.channel),
      fromAddress: maybeText(row.from_address),
      subject: maybeText(row.subject),
      body: maybeText(row.body),
      receivedAt: text(row.received_at),
      status: text(row.status),
      suggestedCaseType: maybeText(row.suggested_case_type),
      suggestedCategory: maybeText(row.suggested_category),
      suggestedPriority: maybeText(row.suggested_priority),
      suggestedAccount: maybeText(row.suggested_account),
      confidence: maybeNum(row.confidence),
      rationale: maybeText(row.rationale),
      reviewStatus: maybeText(row.review_status),
    };
  });
}
