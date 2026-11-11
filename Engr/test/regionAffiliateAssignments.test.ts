import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { migrations } from '../db/migrations/index.ts';
import { runMigrations } from '../db/migrate.ts';
import {
  createRegion, updateRegion, listRegionAffiliates, listRegionsAdmin, getRegion,
} from '../src/lib/engr/repos/adminRegions.ts';
import { createStation, getStation } from '../src/lib/engr/repos/adminStations.ts';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'engr-region-affiliate-'));
  const db = createClient({ url: `file:${join(dir, 'test.db')}` });
  return { db, close() { db.close(); rmSync(dir,{recursive:true,force:true}); } };
}

const root = { orgId:'hass', homeOrgId:'hass', userId:'hass-admin',
  isPlatformOwner:false, roles:['ADMIN'] };
const owner = { ...root, isPlatformOwner:true, roles:['OWNER'] };
const regular = { ...root, roles:['ENGINEERING_MANAGER'] };
const child = { orgId:'kenya', homeOrgId:'kenya', userId:'staff', isPlatformOwner:false, roles:['ADMIN'] };

const organisations = [
  `INSERT INTO organisations (id,name,slug) VALUES ('hass','Hass Group','hass')`,
  `INSERT INTO organisations (id,name,slug,parent_org_id) VALUES ('kenya','Hass Kenya','hpk','hass')`,
  `INSERT INTO organisations (id,name,slug,parent_org_id) VALUES ('uganda','Hass Uganda','hpu','hass')`,
  `INSERT INTO organisations (id,name,slug) VALUES ('other','Separate Tenant','other')`,
  `INSERT INTO organisations (id,name,slug,parent_org_id) VALUES ('otherchild','Another Company','otherchild','other')`,
  `INSERT INTO users (id,org_id,full_name,email) VALUES
    ('hass-admin','hass','Hass Administrator','admin@hasspetroleum.com')`,
] as const;

test('migration 010 preserves Hass legacy records and generates only missing region codes', async () => {
  const {db,close} = setup();
  try {
    for (const migration of migrations.slice(0,9)) await migration.up(db);
    await db.batch([
      ...organisations,
      `INSERT INTO regions (id,org_id,name,code,created_at)
        VALUES ('coast','hass','Coast',NULL,'2026-01-01')`,
      `INSERT INTO regions (id,org_id,name,code,created_at)
        VALUES ('western','hass','Western','REG-000006','2026-01-02')`,
      `INSERT INTO regions (id,org_id,name,code,created_at)
        VALUES ('nairobi','hass','Nairobi',NULL,'2026-01-03')`,
      `INSERT INTO regions (id,org_id,name,code)
        VALUES ('historic','hass','Historic','COAST-OLD')`,
      `INSERT INTO stations (id,org_id,region_id,code,name)
        VALUES ('pump1','hass','coast','OLD-STN','Coast Depot')`,
      `INSERT INTO regions (id,org_id,name,code)
        VALUES ('kampala','uganda','Kampala',NULL)`,
    ], 'write');
    await migrations[9].up(db);
    const result = await db.execute(`SELECT id,org_id,affiliate_org_id,code FROM regions ORDER BY id`);
    const rows = new Map(result.rows.map(r=>[String(r.id),r]));
    assert.equal(rows.get('coast')?.code,'REG-000007');
    assert.equal(rows.get('nairobi')?.code,'REG-000008');
    assert.equal(rows.get('western')?.code,'REG-000006');
    assert.equal(rows.get('historic')?.code,'COAST-OLD');
    assert.equal(rows.get('kampala')?.code,'REG-000001');
    assert.equal(rows.get('coast')?.affiliate_org_id,'hass');
    assert.equal(rows.get('coast')?.org_id,'hass');
    const linked = await db.execute(`SELECT org_id,region_id FROM stations WHERE id='pump1'`);
    assert.equal(linked.rows[0].org_id,'hass');
    assert.equal(linked.rows[0].region_id,'coast');
    await migrations[9].up(db); // migration body is intentionally recoverable on retry
    assert.equal((await db.execute(`SELECT code FROM regions WHERE id='coast'`)).rows[0].code,
      'REG-000007');
  } finally { close(); }
});

test('Hass admin may edit affiliate classification; Hass tenant and station ownership never move', async () => {
  const {db,close}=setup();
  try {
    await runMigrations(db);
    await db.batch(organisations,'write');
    const options = await listRegionAffiliates(db,root);
    assert.deepEqual(options.map(x=>x.name), ['Hass Kenya','Hass Uganda']);
    assert.deepEqual((await listRegionAffiliates(db,regular)).map(x=>x.id), []);
    assert.deepEqual((await listRegionAffiliates(db,child)).map(x=>x.id), ['kenya']);
    assert.equal((await createRegion(db,root,{name:'Invalid',affiliateOrgId:'hass'})).ok,false,
      'Hass Group is not a subsidiary affiliate');
    const created = await createRegion(db,root,{name:'Coast',affiliateOrgId:'kenya'});
    assert.equal(created.ok,true);
    if(!created.ok)return;
    const station = await createStation(db,{orgId:'hass',userId:'hass-admin'},{
      name:'Port Depot',regionId:created.id,address:null,stationManagerId:null,isBase:false,status:'ACTIVE',
    });
    assert.equal(station.ok,true);
    if(!station.ok||!station.id)return;
    const original = await getRegion(db,root,created.id);
    assert.match(original?.code ?? '',/^REG-[0-9]{6}$/);
    const renamed = await updateRegion(db,root,created.id,{name:'Coastal',affiliateOrgId:'uganda'});
    assert.equal(renamed.ok,true);
    const after = await getRegion(db,root,created.id);
    assert.equal(after?.orgId,'hass');
    assert.equal(after?.affiliateOrgId,'uganda');
    assert.equal(after?.affiliateName,'Hass Uganda');
    assert.equal(after?.code,original?.code);
    assert.equal((await getStation(db,'hass',station.id))?.regionId,created.id);
    assert.equal((await getStation(db,'kenya',station.id)),null);
    const denied = await updateRegion(db,root,created.id,{name:'Foreign',affiliateOrgId:'other'});
    assert.equal(denied.ok,false);
    assert.equal((await getRegion(db,owner,created.id))?.name,'Coastal');
    const anotherTenant = {...owner,orgId:'other'};
    assert.deepEqual((await listRegionAffiliates(db,anotherTenant)).map(x=>x.id), ['otherchild']);
    assert.equal((await getRegion(db,anotherTenant,created.id)),null);
    assert.equal((await listRegionsAdmin(db,child)).length,0, 'Hass Group region is not re-owned by Kenya');
    const audits = await db.execute({ sql: `SELECT before_json,after_json FROM audit_logs
      WHERE entity_type='region' AND entity_id=? AND action='regions.update'`, args: [created.id] });
    assert.equal(audits.rows.length,1);
    assert.match(String(audits.rows[0].before_json),/hass/);
    assert.match(String(audits.rows[0].after_json),/kenya/);
  } finally { close(); }
});

test('affiliate-owned region cannot be reclassified as belonging to another affiliate',async()=>{
  const {db,close}=setup();
  try {
    await runMigrations(db);
    await db.batch(organisations,'write');
    const region = await createRegion(db,child,{name:'Local',affiliateOrgId:'kenya'});
    assert.equal(region.ok,true);
    if(!region.ok)return;
    const denial = await updateRegion(db,owner,region.id,{
      name:'Local',affiliateOrgId:'uganda',
    });
    assert.equal(denial.ok,false);
    assert.equal((await getRegion(db,owner,region.id))?.orgId,'kenya');
    assert.equal((await getRegion(db,owner,region.id))?.affiliateOrgId,'kenya');
  } finally { close(); }
});
