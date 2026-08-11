/**
 * Who an organisation's operational mail reaches (Build Prompt 60).
 *
 * The reminders, and every head-of-audit copy beside them, resolve their
 * recipients through `listHoaRecipients`. That lookup asked for SUPER_ADMIN and
 * nothing else, and the platform owner's account carries SUPER_ADMIN and sits
 * inside an organisation, so it resolved a Murikah Labs account as the
 * customer's head of audit and posted them the customer's reminders.
 *
 * This runs the real function against a real database through the real driver:
 * the smoke run's in-process Turso stand-in, seeded with the two accounts that
 * are indistinguishable by role and distinguishable only by
 * `is_platform_owner`. `recipients.ts` imports nothing but a type, so node
 * strips it and loads it directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client/web';
import { FakeTursoServer } from './smoke/fakeTurso.ts';
import { listHoaRecipients } from '../../src/lib/grc/notify/recipients.ts';

const ORG = 'ORG-HASS';
const OTHER_ORG = 'ORG-COAST';

/** A seeded database with two SUPER_ADMINs, one of them the platform owner. */
async function seeded(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = new FakeTursoServer('grc/db/schema.md');
  const url = await server.listen();
  const db = server.db;
  for (const org of [ORG, OTHER_ORG]) {
    db.prepare(`INSERT INTO organizations (organization_id, org_name) VALUES (?, ?)`).run(org, org);
  }
  const users: [string, string, string, string, number][] = [
    // The platform owner: SUPER_ADMIN, inside Hass, running Murikah Labs.
    ['USR-WM', ORG, 'owner@murikah.example', 'SUPER_ADMIN', 1],
    // The instance head of audit: the same role, the same organisation, and the
    // only difference that matters.
    ['USR-HOA', ORG, 'hoa@hass.example', 'SUPER_ADMIN', 0],
    // An auditor, who is not a head of audit at all.
    ['USR-AUD', ORG, 'auditor@hass.example', 'AUDITOR', 0],
    // Another organisation's head of audit, who is none of Hass's business.
    ['USR-COAST', OTHER_ORG, 'hoa@coast.example', 'SUPER_ADMIN', 0],
  ];
  for (const [id, org, email, role, owner] of users) {
    db.prepare(
      `INSERT INTO users (user_id, organization_id, email, full_name, role_code,
         is_platform_owner, status) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
    ).run(id, org, email, email, role, owner);
  }
  // A disabled head of audit, who must not be mailed either.
  db.prepare(
    `INSERT INTO users (user_id, organization_id, email, full_name, role_code,
       is_platform_owner, status) VALUES ('USR-GONE', ?, 'gone@hass.example', 'Gone',
       'SUPER_ADMIN', 0, 'INACTIVE')`,
  ).run(ORG);
  return { url, close: () => server.close() };
}

test('the head of audit is the instance SUPER_ADMIN, never the platform owner', async () => {
  const { url, close } = await seeded();
  try {
    const db = createClient({ url });
    const recipients = await listHoaRecipients(db, ORG, null);
    const ids = recipients.map((r) => r.userId).sort();

    assert.deepEqual(ids, ['USR-HOA'], `only the instance head of audit, got ${ids.join(', ')}`);
    assert.ok(
      !recipients.some((r) => r.email === 'owner@murikah.example'),
      'the platform owner is not addressed, by id or by address',
    );
  } finally {
    await close();
  }
});

test('the copy stays inside the organisation, and skips the triggering user', async () => {
  const { url, close } = await seeded();
  try {
    const db = createClient({ url });
    // Another tenant's head of audit is never a recipient of this one's mail.
    const hass = await listHoaRecipients(db, ORG, null);
    assert.ok(!hass.some((r) => r.userId === 'USR-COAST'), 'no cross-tenant recipient');

    // Coast resolves its own, and does not inherit Hass's.
    const coast = await listHoaRecipients(db, OTHER_ORG, null);
    assert.deepEqual(
      coast.map((r) => r.userId),
      ['USR-COAST'],
    );

    // The person who caused the event is not copied on their own action.
    const excluded = await listHoaRecipients(db, ORG, 'USR-HOA');
    assert.deepEqual(excluded, [], 'the only head of audit was the actor, so nobody is copied');
  } finally {
    await close();
  }
});

test('an organisation with only a platform owner in it mails nobody', async () => {
  // The state that produced the fault: the owner was the only SUPER_ADMIN the
  // lookup could see, so every reminder went to them. Mailing nobody is the
  // correct answer, and it is visibly nobody rather than quietly the wrong
  // person.
  const server = new FakeTursoServer('grc/db/schema.md');
  const url = await server.listen();
  try {
    server.db
      .prepare(`INSERT INTO organizations (organization_id, org_name) VALUES (?, ?)`)
      .run(ORG, ORG);
    server.db
      .prepare(
        `INSERT INTO users (user_id, organization_id, email, full_name, role_code,
           is_platform_owner, status) VALUES ('USR-WM', ?, 'owner@murikah.example', 'Owner',
           'SUPER_ADMIN', 1, 'ACTIVE')`,
      )
      .run(ORG);
    const recipients = await listHoaRecipients(createClient({ url }), ORG, null);
    assert.deepEqual(recipients, []);
  } finally {
    await server.close();
  }
});
