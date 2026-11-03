import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestClient } from './support/db.ts';
import { seedHass } from './support/hassSeed.ts';
import { listInquiryMessages } from '../../src/lib/cms/channels/inbox.ts';

const client = (db: TestClient) => db as unknown as Parameters<typeof listInquiryMessages>[0];
const NAME = 'Dr. Amina N. O’Connor';

async function inboxDb() {
  const db = createTestDb();
  await seedHass(db);
  await db.execute({
    sql: "UPDATE contacts SET full_name=? WHERE contact_id='CON-001'",
    args: [NAME],
  });
  for (const channel of ['EMAIL', 'WHATSAPP']) {
    await db.execute({
      sql: `INSERT INTO channel_connections(
              channel_connection_id,channel,display_name,provider,account_identifier,secret_name,status)
            VALUES(?,?,?,?,?,?,'CONNECTED')`,
      args: [
        channel,
        channel,
        `${channel} inquiries`,
        channel === 'EMAIL' ? 'MICROSOFT' : 'META',
        `${channel.toLowerCase()}-test`,
        'TEST_ONLY_CHANNEL_SECRET',
      ],
    });
    await db.execute({
      sql: `INSERT INTO channel_messages(
              channel_message_id,channel_connection_id,external_message_id,direction,
              subject,received_at,account_id,contact_id,status)
            VALUES(?,?,?,'INBOUND','Test inquiry','2026-11-03 09:00:00','ACC-001','CON-001','RECEIVED')`,
      args: [`MSG-${channel}`, channel, `external-${channel}`],
    });
  }
  return db;
}

test('the inbox query compiles against contacts.full_name even when there are no messages', async () => {
  const db = createTestDb();
  try {
    assert.deepEqual(await listInquiryMessages(client(db)), []);
  } finally {
    db.close();
  }
});

for (const channel of ['EMAIL', 'WHATSAPP']) {
  test(`${channel} inbox returns the complete stored contact name`, async () => {
    const db = await inboxDb();
    try {
      const rows = await listInquiryMessages(client(db), { channel });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.channel, channel);
      assert.equal(rows[0]?.contactName, NAME);
      assert.equal(rows[0]?.accountId, 'ACC-001');
    } finally {
      db.close();
    }
  });
}

test('messages without a linked contact retain a null contact name', async () => {
  const db = await inboxDb();
  try {
    await db.execute(`INSERT INTO channel_messages(
        channel_message_id,channel_connection_id,external_message_id,direction,received_at,status)
      VALUES('MSG-UNLINKED','EMAIL','external-unlinked','INBOUND','2026-11-03 10:00:00','RECEIVED')`);
    const rows = await listInquiryMessages(client(db));
    assert.equal(rows.length, 3);
    assert.equal(rows.find((row) => row.channelMessageId === 'MSG-UNLINKED')?.contactName, null);
    assert.equal(rows.find((row) => row.channelMessageId === 'MSG-EMAIL')?.contactName, NAME);
    assert.deepEqual((await db.execute('PRAGMA foreign_key_check')).rows, []);
  } finally {
    db.close();
  }
});
