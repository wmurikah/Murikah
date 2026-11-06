import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { runMigrations } from '../db/migrate.ts';
import { createContractor } from '../src/lib/engr/repos/adminContractors.ts';
import { createStation } from '../src/lib/engr/repos/adminStations.ts';
import { createTechnician } from '../src/lib/engr/repos/adminTechnicians.ts';
import {
  createAssignment,
  listEngineerCandidates,
} from '../src/lib/engr/repos/engineerAssignments.ts';

test('setup links only organisation users holding the required portal or operational role', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'engr-role-links-'));
  const db = createClient({ url: `file:${join(directory, 'test.db')}` });
  try {
    await runMigrations(db);
    await db.executeMultiple(readFileSync(new URL('../db/seed.sql', import.meta.url), 'utf8'));
    await db.batch(
      [
        { sql: `INSERT INTO organisations (id,name,slug) VALUES ('o1','One','one')`, args: [] },
        { sql: `INSERT INTO organisations (id,name,slug) VALUES ('o2','Two','two')`, args: [] },
        ...[
          ['actor', 'o1', 'Manager', 'manager@example.test'],
          ['eng', 'o1', 'Engineer', 'engineer@example.test'],
          ['station', 'o1', 'Station Manager', 'station@example.test'],
          ['contractor-user', 'o1', 'Contractor User', 'contractor@example.test'],
          ['tech-user', 'o1', 'Technician User', 'tech@example.test'],
          ['viewer', 'o1', 'Viewer', 'viewer@example.test'],
          ['foreign-tech', 'o2', 'Foreign Tech', 'foreign@example.test'],
        ].map(([id, org, name, email]) => ({
          sql: `INSERT INTO users (id,org_id,full_name,email) VALUES (?,?,?,?)`,
          args: [id, org, name, email],
        })),
        ...[
          ['actor', 'ENGINEERING_MANAGER'],
          ['eng', 'ENGINEER'],
          ['station', 'STATION_MANAGER'],
          ['contractor-user', 'CONTRACTOR'],
          ['tech-user', 'TECHNICIAN'],
          ['viewer', 'VIEWER'],
          ['foreign-tech', 'TECHNICIAN'],
        ].map(([user, role]) => ({
          sql: `INSERT INTO user_roles (user_id,role_id)
                SELECT ?,id FROM roles WHERE org_id IS NULL AND code=?`,
          args: [user, role],
        })),
      ],
      'write',
    );

    const ctx = { orgId: 'o1', userId: 'actor' };
    const invalidManager = await createStation(db, ctx, {
      code: 'BAD',
      name: 'Bad station',
      regionId: null,
      address: null,
      stationManagerId: 'viewer',
      isBase: false,
      status: 'ACTIVE',
    });
    assert.equal(invalidManager.ok, false);
    const station = await createStation(db, ctx, {
      code: 'S1',
      name: 'Station One',
      regionId: null,
      address: null,
      stationManagerId: 'station',
      isBase: false,
      status: 'ACTIVE',
    });
    assert.equal(station.ok, true);
    if (!station.ok || !station.id) return;

    const candidates = await listEngineerCandidates(db, 'o1');
    assert.deepEqual(candidates.map((row) => row.id).sort(), ['actor', 'eng']);
    const wrongEngineer = await createAssignment(db, ctx, {
      engineerUserId: 'viewer',
      scopeType: 'STATION',
      stationId: station.id,
      categoryId: null,
    });
    assert.equal(wrongEngineer.ok, false);
    const assignment = await createAssignment(db, ctx, {
      engineerUserId: 'eng',
      scopeType: 'STATION',
      stationId: station.id,
      categoryId: null,
    });
    assert.equal(assignment.ok, true);
    const duplicate = await createAssignment(db, ctx, {
      engineerUserId: 'actor',
      scopeType: 'STATION',
      stationId: station.id,
      categoryId: null,
    });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.code, 'conflict');

    const wrongPortal = await createContractor(db, ctx, {
      name: 'Wrong portal',
      contactPerson: null,
      email: null,
      phone: null,
      baseStationId: null,
      isPrequalified: true,
      status: 'ACTIVE',
      portalUserId: 'viewer',
      stationIds: [station.id],
      categoryIds: [],
    });
    assert.equal(wrongPortal.ok, false);
    const contractor = await createContractor(db, ctx, {
      name: 'Vendor',
      contactPerson: null,
      email: null,
      phone: null,
      baseStationId: station.id,
      isPrequalified: true,
      status: 'ACTIVE',
      portalUserId: 'contractor-user',
      stationIds: [station.id],
      categoryIds: [],
    });
    assert.equal(contractor.ok, true);
    if (!contractor.ok || !contractor.id) return;

    const foreignContractor = await db.execute(
      `INSERT INTO contractors (id,org_id,name) VALUES ('foreign-contractor','o2','Foreign')`,
    );
    assert.equal(foreignContractor.rowsAffected, 1);
    const crossOrg = await createTechnician(db, ctx, {
      contractorId: 'foreign-contractor',
      fullName: 'Cross org',
      phone: null,
      email: null,
      status: 'ACTIVE',
      portalUserId: 'foreign-tech',
    });
    assert.equal(crossOrg.ok, false);
    const wrongTechRole = await createTechnician(db, ctx, {
      contractorId: contractor.id,
      fullName: 'Wrong role',
      phone: null,
      email: null,
      status: 'ACTIVE',
      portalUserId: 'viewer',
    });
    assert.equal(wrongTechRole.ok, false);
    const technician = await createTechnician(db, ctx, {
      contractorId: contractor.id,
      fullName: 'Tech',
      phone: null,
      email: null,
      status: 'ACTIVE',
      portalUserId: 'tech-user',
    });
    assert.equal(technician.ok, true);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
