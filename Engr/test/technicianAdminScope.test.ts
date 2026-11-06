import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { runMigrations } from '../db/migrate.ts';
import {
  createTechnician,
  listTechniciansAdmin,
  updateTechnician,
} from '../src/lib/engr/repos/adminTechnicians.ts';

test('contractor technician administration cannot cross contractor boundaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'engr-technician-scope-'));
  const db = createClient({ url: `file:${join(directory, 'test.db')}` });
  try {
    await runMigrations(db);
    await db.batch(
      [
        { sql: `INSERT INTO organisations (id, name, slug) VALUES ('o1','Org','org')`, args: [] },
        {
          sql: `INSERT INTO users (id, org_id, full_name, email) VALUES ('u1','o1','Portal','p@example.com')`,
          args: [],
        },
        { sql: `INSERT INTO contractors (id, org_id, name) VALUES ('c1','o1','One')`, args: [] },
        { sql: `INSERT INTO contractors (id, org_id, name) VALUES ('c2','o1','Two')`, args: [] },
        {
          sql: `INSERT INTO technicians (id, org_id, contractor_id, full_name) VALUES ('t1','o1','c1','Tech One')`,
          args: [],
        },
        {
          sql: `INSERT INTO technicians (id, org_id, contractor_id, full_name) VALUES ('t2','o1','c2','Tech Two')`,
          args: [],
        },
      ],
      'write',
    );

    const visible = await listTechniciansAdmin(db, 'o1', 'c1');
    assert.deepEqual(
      visible.map((row) => row.id),
      ['t1'],
    );

    const ctx = { orgId: 'o1', userId: 'u1', contractorId: 'c1' };
    const crossCreate = await createTechnician(db, ctx, {
      contractorId: 'c2',
      fullName: 'Wrong contractor',
      phone: null,
      email: null,
      status: 'ACTIVE',
    });
    assert.deepEqual(crossCreate, {
      ok: false,
      code: 'forbidden',
      message: 'Technicians must belong to your contractor.',
    });

    const crossUpdate = await updateTechnician(db, ctx, 't2', {
      contractorId: 'c1',
      fullName: 'Attempted takeover',
      phone: null,
      email: null,
      status: 'ACTIVE',
    });
    assert.equal(crossUpdate.ok, false);
    if (!crossUpdate.ok) assert.equal(crossUpdate.code, 'not_found');

    const untouched = await db.execute(
      `SELECT full_name, contractor_id FROM technicians WHERE id='t2'`,
    );
    assert.equal(String(untouched.rows[0].full_name), 'Tech Two');
    assert.equal(String(untouched.rows[0].contractor_id), 'c2');
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
