import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { runMigrations } from '../db/migrate.ts';
import { listLegacyWorkOrders } from '../src/lib/engr/repos/legacyWorkOrders.ts';

test('legacy archive is read-only, tenant-scoped and never creates live work orders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engr-legacy-wo-'));
  const db = createClient({ url: `file:${join(dir, 'test.db')}` });
  try {
    await runMigrations(db);
    await db.batch([
      `INSERT INTO organisations (id,name,slug) VALUES ('hass','Hass Group','hass')`,
      `INSERT INTO organisations (id,name,slug) VALUES ('other','Other','other')`,
      `INSERT INTO stations (id,org_id,code,name) VALUES ('station1','hass','STN-000001','Hass Bahati')`,
      `INSERT INTO legacy_work_order_history
          (id,org_id,source_file,source_row,reported_date,location_source,
           suggested_location,station_id,wo_reference_source,description,contractor_source,review_state)
          VALUES ('h1','hass','tracker.xlsx',5,'2021-09-20','Bahati','Hass Bahati',
                  'station1','WO 603','Fix fuel pump','Universal','MATCHED')`,
      `INSERT INTO legacy_work_order_history
          (id,org_id,source_file,source_row,location_source,wo_reference_source,description)
          VALUES ('h2','hass','tracker.xlsx',6,'Consumer site','WO 604','Test generator')`,
      `INSERT INTO legacy_work_order_history
          (id,org_id,source_file,source_row,location_source,wo_reference_source,description)
          VALUES ('h3','other','tracker.xlsx',5,'Private','WO 603','Do not expose')`,
    ], 'write');

    const all = await listLegacyWorkOrders(db,'hass',1);
    assert.equal(all.total,2);
    assert.equal(all.rows.length,2);
    assert.equal(all.rows.find(r=>r.id==='h1')?.location,'Hass Bahati');
    assert.equal(all.rows.find(r=>r.id==='h1')?.isLinked,true);
    assert.equal(all.rows.find(r=>r.id==='h2')?.isLinked,false);
    assert.equal(all.rows.some(r=>r.id==='h3'),false,'other tenant must remain private');
    assert.equal((await listLegacyWorkOrders(db,'other',1)).total,1);
    assert.equal((await listLegacyWorkOrders(db,'hass',1,'fuel pump')).total,1);
    assert.equal((await listLegacyWorkOrders(db,'hass',1,'%')).total,0,
      'SQL wildcard input is treated as a literal');
    assert.equal((await db.execute('SELECT COUNT(*) AS n FROM work_orders')).rows[0].n,0);
    assert.deepEqual((await db.execute('PRAGMA foreign_key_check')).rows,[]);
  } finally {
    db.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('archive UI remains inside Work orders, without adding a sidebar item', () => {
  const main = readFileSync(new URL('../src/pages/engr/workorders/index.astro',import.meta.url),'utf8');
  const history = readFileSync(new URL('../src/pages/engr/workorders/history.astro',import.meta.url),'utf8');
  const nav = readFileSync(new URL('../src/layouts/EngrLayout.astro',import.meta.url),'utf8');
  assert.match(main,/href="\/workorders\/history"/);
  assert.match(history,/workorder\.view/);
  assert.match(history,/actorDataScope\(engr\.roles\) === 'org'/);
  assert.match(history,/not active work orders or verified closures/i);
  assert.doesNotMatch(nav,/label: 'Historical tracker'/);
});
