import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mfaEnforced, setMfaEnforced } from '../src/lib/engr/auth/mfaPolicy.ts';

test('MFA is enforced by default; only an explicit pause changes it and every change is audited', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'engr-mfa-policy-'));
  const db = createClient({ url: `file:${join(directory, 'db.sqlite')}` });
  try {
    await db.execute(`CREATE TABLE org_settings (
      org_id TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL, updated_at TEXT,
      PRIMARY KEY(org_id, key))`);
    await db.execute(`CREATE TABLE audit_logs (
      org_id TEXT, actor_user_id TEXT, action TEXT, entity_type TEXT, entity_id TEXT,
      before_json TEXT, after_json TEXT)`);
    assert.equal(await mfaEnforced(db, 'kenya'), true);
    await setMfaEnforced(db, { orgId: 'kenya', actorUserId: 'owner', enforced: false });
    assert.equal(await mfaEnforced(db, 'kenya'), false);
    assert.equal(await mfaEnforced(db, 'uganda'), true);
    await setMfaEnforced(db, { orgId: 'kenya', actorUserId: 'owner', enforced: true });
    assert.equal(await mfaEnforced(db, 'kenya'), true);
    const audit = await db.execute(`SELECT before_json, after_json FROM audit_logs ORDER BY rowid`);
    assert.deepEqual(
      audit.rows.map((row) => [row.before_json, row.after_json]),
      [
        ['{"enforced":true}', '{"enforced":false}'],
        ['{"enforced":false}', '{"enforced":true}'],
      ],
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
