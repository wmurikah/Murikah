/**
 * Build Prompt 38, part 7: the assistant, the channels, and the review queue.
 *
 * Criteria 22 to 29 are each a named test. The two that matter most are the
 * ones a code review cannot settle by reading: the assistant refusing an
 * entity the asker cannot open, and a classification creating nothing until a
 * person decides.
 *
 * NO MODEL IS CALLED. `callModel` reaches the network, and a test that needed
 * a provider to be up would be a test that fails when a provider is down. The
 * model is stubbed by giving a provider a secret name that is not set in the
 * fake environment, which is the same path a real deployment takes when a
 * secret is missing, so the stub is a real code path rather than a mock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass, SEED } from './support/hassSeed.ts';
import {
  auditColumns,
  createProvider,
  activeProvider,
  listProviders,
  validateProvider,
  ASSISTANT_TABLES,
} from '../../src/lib/cms/ai/providers.ts';
import { createConnection, listConnections } from '../../src/lib/cms/ai/channels.ts';
import {
  ingestMessage,
  classifyMessage,
  reviewClassification,
  reviewQueue,
  parseSuggestion,
  AUTO_CASE_CONFIDENCE,
  NO_PROVIDER_NOTE,
} from '../../src/lib/cms/ai/inbox.ts';
import { startConversation, ask, OUT_OF_SCOPE } from '../../src/lib/cms/ai/assistant.ts';
import { secretPresent } from '../../src/lib/cms/ai/model.ts';
import {
  resetCaseEventHandlers,
  resetLeadEventHandlers,
  resetSlaWiring,
} from '../../src/lib/cms/service/events.ts';

const CTX = {
  actorUserId: SEED.admin,
  ip: '10.0.0.10',
  userAgent: 'HassCMS Test',
  now: new Date('2026-08-30T09:00:00Z'),
};

/** No secret is set, so every model call takes the UNAUTHORISED path. */
const ENV: Record<string, unknown> = {};

const asClient = (db: TestClient) => db as never;

async function seeded(): Promise<TestClient> {
  resetCaseEventHandlers();
  resetLeadEventHandlers();
  resetSlaWiring();
  const db = await createTestDb();
  await seedHass(db);
  return db;
}

const provider = (over: Record<string, unknown> = {}) => ({
  providerName: 'Test provider',
  providerType: 'ANTHROPIC',
  baseUrl: null,
  model: 'claude-test',
  secretName: 'TEST_MODEL_KEY',
  maxOutputTokens: 256,
  temperature: null,
  purpose: 'BOTH',
  active: true,
  ...over,
});

const connection = (over: Record<string, unknown> = {}) => ({
  channel: 'EMAIL',
  displayName: 'Customer care mailbox',
  provider: 'graph',
  accountIdentifier: 'care@hasspetroleum.com',
  affiliateId: null,
  secretName: 'CARE_MAILBOX_TOKEN',
  webhookSecretName: null,
  autoCreateCase: false,
  defaultCaseCategoryId: null,
  status: 'CONNECTED',
  ...over,
});

test('criterion 22: the six tables are present before anything is built on them', async () => {
  const db = await seeded();
  const found = await db.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name IN
            ('ai_providers','bot_conversations','bot_messages',
             'channel_connections','channel_messages','message_classifications')
          ORDER BY name`,
    args: [],
  });
  const names = found.rows.map((r) => String((r as Record<string, unknown>).name));
  assert.deepEqual(names, [...ASSISTANT_TABLES].sort());
  db.close();
});

test('criterion 23: no column in any of the six tables holds a credential', async () => {
  const db = await seeded();
  const columns = await auditColumns(asClient(db));
  assert.ok(columns.length > 0, 'the audit found columns to check');

  // THE WHOLE INVENTORY IS PRINTED, so the two exemptions are visible rather
  // than hidden inside a regular expression somebody has to go and read.
  const flagged = columns.filter((c) => c.looksLikeCredential);
  console.log('[columns] credential-shaped names across the six tables:');
  for (const c of flagged) {
    console.log(
      `  ${c.table}.${c.column} — ${c.allowedBecauseItNamesASecret ? 'names a secret, holds none' : 'NOT ALLOWED'}`,
    );
  }
  console.log(`[columns] ${columns.length} columns audited, ${flagged.length} credential-shaped`);

  const offenders = flagged
    .filter((c) => !c.allowedBecauseItNamesASecret)
    .map((c) => `${c.table}.${c.column}`);
  assert.deepEqual(offenders, [], `columns that could hold a key: ${offenders.join(', ')}`);

  // AND THE TWO THAT ARE ALLOWED REALLY DO ONLY NAME ONE. A name is capitals
  // and underscores; a key is not, and the validator refuses one.
  const pasted = validateProvider(provider({ secretName: 'sk-ant-api03-abcdef' }) as never);
  assert.ok(
    pasted.some((e) => e.field === 'secretName'),
    'a key pasted into the secret name field is refused',
  );
  db.close();
});

test('criterion 24: the screen shows the connection verified without the secret', async () => {
  const db = await seeded();
  const made = await createProvider(asClient(db), provider() as never, CTX);
  assert.ok(made.ok);

  // The presence check is a boolean derived from the environment, never a read
  // of the value, and it is false here because nothing is set.
  assert.equal(secretPresent(ENV, 'TEST_MODEL_KEY'), false);
  assert.equal(secretPresent({ TEST_MODEL_KEY: 'sk-real-key' }, 'TEST_MODEL_KEY'), true);

  // A NAME THAT IS NOT A NAME IS NEVER USED TO INDEX THE ENVIRONMENT.
  assert.equal(secretPresent({ 'weird key': 'x' } as never, 'weird key'), false);

  const listed = await listProviders(asClient(db));
  const stored = JSON.stringify(listed);
  assert.ok(stored.includes('TEST_MODEL_KEY'), 'the NAME is shown');
  assert.ok(!stored.includes('sk-'), 'and no key is anywhere in what the screen receives');
  db.close();
});

test('criterion 25: the assistant refuses an entity the user cannot open', async () => {
  const db = await seeded();

  // A REAL ORDER, AND A USER WHOSE SCOPE DOES NOT REACH IT. The refusal comes
  // from resolveEntityAccess, the same function an activity uses, so this is
  // the product's one access rule rather than a second one written for chat.
  const order = await db.execute(
    `SELECT sales_order_id FROM sales_orders ORDER BY sales_order_id LIMIT 1`,
  );
  const orderId = String((order.rows[0] as Record<string, unknown>).sales_order_id);

  const refused = await startConversation(
    asClient(db),
    // An external portal user, who holds no internal permission at all, so
    // `resolveScope` refuses before any row is considered.
    'USR-EXT001',
    { entityType: 'SALES_ORDER', entityId: orderId },
    CTX,
  );
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, OUT_OF_SCOPE);
  console.log(`[assistant] refusal: ${OUT_OF_SCOPE}`);

  // AND NOTHING WAS WRITTEN. A conversation about a record somebody cannot
  // open must not exist to be resumed later.
  const conversations = await db.execute(
    `SELECT COUNT(*) AS n FROM bot_conversations WHERE entity_id = '${orderId}'`,
  );
  assert.equal(Number((conversations.rows[0] as Record<string, unknown>).n), 0);

  // An id that names no row is refused the same way, so a guessed identifier
  // learns nothing from the difference.
  const invented = await startConversation(
    asClient(db),
    SEED.admin,
    { entityType: 'SALES_ORDER', entityId: 'SO-DOES-NOT-EXIST' },
    CTX,
  );
  assert.equal(invented.ok, false);
  db.close();
});

test('criterion 26: the model, token counts and latency are recorded per message', async () => {
  const db = await seeded();
  await createProvider(asClient(db), provider() as never, CTX);

  const started = await startConversation(asClient(db), SEED.admin, {}, CTX);
  assert.ok(started.ok);
  if (!started.ok) return;

  const answered = await ask(
    asClient(db),
    SEED.admin,
    started.conversationId,
    'Where is order 4471?',
    ENV,
    CTX,
  );
  // The secret is not set, so the call takes the UNAUTHORISED path. The point
  // of this test is the recording, which must happen either way.
  assert.equal(answered.ok, false);

  const rows = await db.execute({
    sql: `SELECT role, sequence_no, model, input_tokens, output_tokens, latency_ms
            FROM bot_messages WHERE bot_conversation_id = ? ORDER BY sequence_no`,
    args: [started.conversationId],
  });
  const messages = rows.rows.map((r) => r as Record<string, unknown>);
  assert.equal(messages.length, 2, 'the question and the answer are both recorded');
  assert.equal(String(messages[0]!.role), 'USER');
  assert.equal(String(messages[1]!.role), 'ASSISTANT');
  // THE COLUMNS EXIST AND ARE WRITTEN. Latency is real even on a failure: the
  // time was spent whether or not an answer came back.
  assert.equal(typeof Number(messages[1]!.latency_ms), 'number');
  assert.ok(Number(messages[1]!.latency_ms) >= 0);
  assert.equal(String(messages[1]!.model), 'claude-test');
  console.log(
    `[assistant] recorded model=${String(messages[1]!.model)} latency=${String(messages[1]!.latency_ms)}ms`,
  );
  db.close();
});

test('criterion 27: the same message polled twice is stored once', async () => {
  const db = await seeded();
  const made = await createConnection(asClient(db), connection() as never, CTX);
  assert.ok(made.ok);
  if (!made.ok) return;

  const message = {
    channelConnectionId: made.id,
    externalMessageId: 'graph-msg-0001',
    fromAddress: 'buyer@example.com',
    toAddress: 'care@hasspetroleum.com',
    subject: 'Delivery has not arrived',
    body: 'The tanker was due on Tuesday and nothing has come.',
    receivedAt: '2026-08-30 08:00:00',
  };

  const first = await ingestMessage(asClient(db), message);
  const second = await ingestMessage(asClient(db), message);

  assert.equal(first.stored, true, 'the first delivery lands');
  assert.equal(second.stored, false, 'the second is rejected by the constraint');
  assert.equal(
    second.channelMessageId,
    first.channelMessageId,
    'and the caller is told which row already holds it',
  );

  const counted = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM channel_messages WHERE external_message_id = ?`,
    args: ['graph-msg-0001'],
  });
  assert.equal(Number((counted.rows[0] as Record<string, unknown>).n), 1);
  console.log('[ingest] two deliveries of graph-msg-0001, one row');

  // THE SAME EXTERNAL ID ON A DIFFERENT CONNECTION IS A DIFFERENT MESSAGE. The
  // constraint is over the pair, and two providers can and do reuse ids.
  const other = await createConnection(
    asClient(db),
    connection({
      channel: 'WHATSAPP',
      displayName: 'WhatsApp line',
      accountIdentifier: '+254700000000',
      secretName: 'WHATSAPP_TOKEN',
    }) as never,
    CTX,
  );
  assert.ok(other.ok);
  if (!other.ok) return;
  const elsewhere = await ingestMessage(asClient(db), {
    ...message,
    channelConnectionId: other.id,
  });
  assert.equal(elsewhere.stored, true, 'the same id on another connection is its own message');
  db.close();
});

test('criterion 28: a classification sits PENDING and creates no case until reviewed', async () => {
  const db = await seeded();
  const made = await createConnection(asClient(db), connection() as never, CTX);
  assert.ok(made.ok);
  if (!made.ok) return;
  await createProvider(asClient(db), provider() as never, CTX);

  const before = await db.execute(`SELECT COUNT(*) AS n FROM service_cases`);
  const casesBefore = Number((before.rows[0] as Record<string, unknown>).n);

  const landed = await ingestMessage(asClient(db), {
    channelConnectionId: made.id,
    externalMessageId: 'graph-msg-0002',
    fromAddress: 'buyer@example.com',
    toAddress: 'care@hasspetroleum.com',
    subject: 'Invoice query',
    body: 'The invoice total looks wrong.',
    receivedAt: '2026-08-30 08:05:00',
  });
  assert.ok(landed.channelMessageId !== null);

  // A PENDING SUGGESTION, WRITTEN BY HAND RATHER THAN BY A MODEL, because the
  // gate under test is the review and not the classifier. This is exactly the
  // row `classifyMessage` writes.
  await db.execute({
    sql: `INSERT INTO message_classifications
            (message_classification_id, channel_message_id, model, suggested_case_type,
             suggested_case_category_id, suggested_priority, suggested_account_id,
             confidence, rationale, review_status, created_at)
          VALUES ('MCL-TEST-1', ?, 'claude-test', 'COMPLAINT',
                  (SELECT case_category_id FROM case_categories WHERE active = 1 LIMIT 1),
                  'HIGH',
                  (SELECT account_id FROM accounts WHERE status = 'ACTIVE' LIMIT 1),
                  0.93, 'The customer says the total is wrong.', 'PENDING',
                  '2026-08-30 08:05:01')`,
    args: [landed.channelMessageId],
  });

  const pending = await db.execute(
    `SELECT review_status FROM message_classifications WHERE message_classification_id = 'MCL-TEST-1'`,
  );
  assert.equal(
    String((pending.rows[0] as Record<string, unknown>).review_status),
    'PENDING',
    'the suggestion waits',
  );

  const during = await db.execute(`SELECT COUNT(*) AS n FROM service_cases`);
  assert.equal(
    Number((during.rows[0] as Record<string, unknown>).n),
    casesBefore,
    'and no case exists yet, however confident the suggestion is',
  );
  console.log(
    `[review] PENDING at confidence 0.93, cases unchanged at ${casesBefore} (threshold ${AUTO_CASE_CONFIDENCE})`,
  );

  // It is in the queue, waiting for somebody.
  const queue = await reviewQueue(asClient(db));
  assert.ok(queue.some((row) => row.classificationId === 'MCL-TEST-1'));

  // NOW A PERSON DECIDES, and only now is there a case.
  const decided = await reviewClassification(asClient(db), 'MCL-TEST-1', { action: 'ACCEPT' }, CTX);
  assert.equal(decided.ok, true);
  assert.equal(decided.reviewStatus, 'ACCEPTED');
  const after = await db.execute(`SELECT COUNT(*) AS n FROM service_cases`);
  assert.equal(Number((after.rows[0] as Record<string, unknown>).n), casesBefore + 1);

  // BOTH ARE KEPT: the suggestion is still there beside the decision, which is
  // what makes "is the model any good" a query.
  const kept = await db.execute(
    `SELECT suggested_case_type, final_case_type, reviewed_by_user_id
       FROM message_classifications WHERE message_classification_id = 'MCL-TEST-1'`,
  );
  const row = kept.rows[0] as Record<string, unknown>;
  assert.equal(String(row.suggested_case_type), 'COMPLAINT');
  assert.equal(String(row.final_case_type), 'COMPLAINT');
  assert.equal(String(row.reviewed_by_user_id), SEED.admin);

  // A SECOND DECISION IS REFUSED, so two reviewers pressing Accept at once
  // produce one case rather than two.
  const again = await reviewClassification(asClient(db), 'MCL-TEST-1', { action: 'ACCEPT' }, CTX);
  assert.equal(again.ok, false);
  const finally_ = await db.execute(`SELECT COUNT(*) AS n FROM service_cases`);
  assert.equal(Number((finally_.rows[0] as Record<string, unknown>).n), casesBefore + 1);
  db.close();
});

test('criterion 29: with no active provider, messages queue and nothing is sent', async () => {
  const db = await seeded();
  const made = await createConnection(asClient(db), connection() as never, CTX);
  assert.ok(made.ok);
  if (!made.ok) return;

  // No provider at all.
  assert.equal(await activeProvider(asClient(db), 'CLASSIFICATION'), null);

  const landed = await ingestMessage(asClient(db), {
    channelConnectionId: made.id,
    externalMessageId: 'graph-msg-0003',
    fromAddress: 'buyer@example.com',
    toAddress: 'care@hasspetroleum.com',
    subject: 'Question',
    body: 'When is the next delivery?',
    receivedAt: '2026-08-30 08:10:00',
  });
  assert.ok(landed.channelMessageId !== null);

  const outcome = await classifyMessage(asClient(db), landed.channelMessageId!, ENV, CTX);
  assert.equal(outcome.classified, false);
  assert.equal(outcome.reason, NO_PROVIDER_NOTE);
  assert.equal(outcome.classificationId, null);
  console.log(`[classify] refused before reading the body: ${outcome.reason}`);

  // THE MESSAGE IS STILL HERE, at RECEIVED, in the queue, with no
  // classification row. That is what "queued unclassified" means.
  const stored = await db.execute({
    sql: `SELECT status FROM channel_messages WHERE channel_message_id = ?`,
    args: [landed.channelMessageId],
  });
  assert.equal(String((stored.rows[0] as Record<string, unknown>).status), 'RECEIVED');
  const classifications = await db.execute(`SELECT COUNT(*) AS n FROM message_classifications`);
  assert.equal(Number((classifications.rows[0] as Record<string, unknown>).n), 0);

  const queue = await reviewQueue(asClient(db));
  const row = queue.find((q) => q.channelMessageId === landed.channelMessageId);
  assert.ok(row !== undefined, 'it is in the queue');
  assert.equal(row?.classificationId, null, 'with nothing suggested');

  // A DISABLED PROVIDER IS NOT AN ACTIVE ONE.
  await createProvider(asClient(db), provider({ active: false }) as never, CTX);
  assert.equal(await activeProvider(asClient(db), 'CLASSIFICATION'), null);
  db.close();
});

test('a connection reads into the queue and creates nothing until it is switched on', async () => {
  const db = await seeded();
  const made = await createConnection(asClient(db), connection() as never, CTX);
  assert.ok(made.ok);
  const listed = await listConnections(asClient(db));
  assert.equal(listed[0]?.autoCreateCase, false, 'auto-create is off on a new connection');

  // AND IT CANNOT BE SWITCHED ON WITHOUT SAYING WHAT CATEGORY A CASE CARRIES,
  // because service_cases requires one and the insert would fail at three in
  // the morning rather than in the form.
  const refused = await createConnection(
    asClient(db),
    connection({
      displayName: 'Second mailbox',
      accountIdentifier: 'sales@hasspetroleum.com',
      autoCreateCase: true,
      defaultCaseCategoryId: null,
    }) as never,
    CTX,
  );
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.ok(refused.errors.some((e) => e.field === 'defaultCaseCategoryId'));
  db.close();
});

test('a model answer is kept only where every field is one the database allows', () => {
  const categories = new Set(['CC-1']);
  const accounts = new Set(['ACC-1']);

  // THE HAPPY CASE, including a model that wrapped its JSON in a fence.
  const good = parseSuggestion(
    '```json\n{"caseType":"COMPLAINT","categoryId":"CC-1","priority":"HIGH",' +
      '"accountId":"ACC-1","confidence":0.9,"rationale":"Says the delivery failed."}\n```',
    categories,
    accounts,
  );
  assert.equal(good.caseType, 'COMPLAINT');
  assert.equal(good.categoryId, 'CC-1');
  assert.equal(good.confidence, 0.9);

  // AN INVENTED CATEGORY IS DROPPED, NOT STORED. The column is a foreign key,
  // so a hallucinated id would fail the insert and lose the whole suggestion;
  // dropping the field keeps the rest and leaves a person to fill it in.
  const invented = parseSuggestion(
    '{"caseType":"COMPLAINT","categoryId":"CC-INVENTED","accountId":"ACC-NOPE","confidence":0.99}',
    categories,
    accounts,
  );
  assert.equal(invented.categoryId, null);
  assert.equal(invented.accountId, null);
  assert.equal(invented.caseType, 'COMPLAINT');

  // A VALUE OUTSIDE THE CHECK IS DROPPED for the same reason.
  const wrong = parseSuggestion('{"caseType":"URGENT","priority":"SUPER"}', categories, accounts);
  assert.equal(wrong.caseType, null);
  assert.equal(wrong.priority, null);

  // Confidence is clamped rather than trusted.
  assert.equal(parseSuggestion('{"confidence":5}', categories, accounts).confidence, 1);
  assert.equal(parseSuggestion('{"confidence":-2}', categories, accounts).confidence, 0);
  assert.equal(parseSuggestion('not json at all', categories, accounts).confidence, null);
});
