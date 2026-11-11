import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { runMigrations } from '../db/migrate.ts';
import {
  listRegionAffiliates, listRegionsAdmin, getRegion, updateRegion,
} from '../src/lib/engr/repos/adminRegions.ts';
import { listStationsAdmin, createStation, updateStation } from '../src/lib/engr/repos/adminStations.ts';

test('Hass root is never selectable, while existing root-classified regions and stations stay intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engr-affiliate-only-'));
  const db = createClient({ url: `file:${join(dir,'test.db')}` });
  try {
    await runMigrations(db);
    await db.batch([
      `INSERT INTO organisations (id,name,slug) VALUES ('hass','Hass Group','hass')`,
      `INSERT INTO organisations (id,name,slug,parent_org_id) VALUES ('kenya','Hass Kenya','hpk','hass')`,
      `INSERT INTO organisations (id,name,slug,parent_org_id) VALUES ('uganda','Hass Uganda','hpu','hass')`,
      `INSERT INTO users (id,org_id,full_name,email) VALUES ('admin','hass','Admin','admin@hasspetroleum.com')`,
      `INSERT INTO regions (id,org_id,affiliate_org_id,code,name)
          VALUES ('coast','hass','hass','REG-000001','Coast')`,
      `INSERT INTO stations (id,org_id,affiliate_org_id,region_id,code,name)
          VALUES ('depot','hass','hass','coast','STN-000001','Depot')`,
    ], 'write');
    const actor = { orgId:'hass', homeOrgId:'hass', userId:'admin',
      isPlatformOwner:false, roles:['ADMIN'] };
    assert.deepEqual((await listRegionAffiliates(db,actor)).map((x) => x.id), ['kenya','uganda']);
    assert.equal((await getRegion(db,actor,'coast'))?.affiliateName, 'Unassigned');
    assert.equal((await listRegionsAdmin(db,actor))[0]?.affiliateName, 'Unassigned');
    assert.equal((await listStationsAdmin(db,'hass'))[0]?.affiliateName, 'Unassigned');
    assert.equal((await updateRegion(db,actor,'coast',{
      name:'Coast', affiliateOrgId:'hass',
    })).ok,false,'root selection rejected even on existing legacy rows');
    assert.equal((await createStation(db,actor,{
      name:'Root station',affiliateOrgId:'hass',regionId:null,address:null,
      stationManagerId:null,isBase:false,status:'ACTIVE',
    })).ok,false,'root is not a legal affiliate on station creation');
    assert.equal((await updateStation(db,actor,'depot',{
      name:'Root station',affiliateOrgId:'hass',regionId:'coast',address:null,
      stationManagerId:null,isBase:false,status:'ACTIVE',
    })).ok,false,'root is not a legal affiliate on station update');
    const assigned = await updateRegion(db,actor,'coast',{
      name:'Coast',affiliateOrgId:'kenya',
    });
    assert.equal(assigned.ok,true);
    const region = await db.execute(`SELECT id,org_id,affiliate_org_id,code
      FROM regions WHERE id='coast'`);
    const station = await db.execute(`SELECT id,org_id,affiliate_org_id,region_id,code
      FROM stations WHERE id='depot'`);
    assert.equal(region.rows[0].org_id, 'hass');
    assert.equal(station.rows[0].org_id, 'hass');
    assert.equal(region.rows[0].affiliate_org_id,'kenya');
    assert.equal(station.rows[0].affiliate_org_id,'kenya');
    assert.equal(station.rows[0].region_id,'coast');
    assert.equal(station.rows[0].code,'STN-000001');
  } finally {
    db.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
