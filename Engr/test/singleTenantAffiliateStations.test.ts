import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { runMigrations } from '../db/migrate.ts';
import { resolveActingContext } from '../src/lib/engr/repos/orgContext.ts';
import { createRegion, updateRegion, getRegion } from '../src/lib/engr/repos/adminRegions.ts';
import { createStation, updateStation, getStation, listStationsAdmin } from '../src/lib/engr/repos/adminStations.ts';
import { createAffiliate, listAffiliates } from '../src/lib/engr/repos/adminAffiliates.ts';

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'engr-tenant-affiliates-'));
  const db = createClient({ url: `file:${join(dir, 'test.db')}` });
  return { db, close() { db.close(); rmSync(dir, { recursive:true, force:true }); } };
}
const admin = { orgId:'hass', homeOrgId:'hass', userId:'admin',
  isPlatformOwner:false, roles:['ADMIN'] as string[] };
const owner = { ...admin, isPlatformOwner:true };
const seed = [
  `INSERT INTO organisations (id,name,slug) VALUES ('hass','Hass Group','hass')`,
  `INSERT INTO organisations (id,name,slug,parent_org_id) VALUES ('kenya','Hass Kenya','hpk','hass')`,
  `INSERT INTO organisations (id,name,slug,parent_org_id) VALUES ('uganda','Hass Uganda','hpu','hass')`,
  `INSERT INTO organisations (id,name,slug) VALUES ('external','Other Tenant','external')`,
  `INSERT INTO users (id,org_id,full_name,email) VALUES ('admin','hass','Admin','admin@hasspetroleum.com')`,
];

test('platform switcher has tenant roots only; affiliate IDs never enter the switchable set', async () => {
  const h = harness();
  try {
    await runMigrations(h.db);
    await h.db.batch(seed,'write');
    const ctx = await resolveActingContext(h.db,'hass','Hass Group','hass',true,'kenya');
    assert.deepEqual(ctx.switchable.map(x=>x.id), ['hass','external'].sort((a,b)=>
      ({hass:'Hass Group',external:'Other Tenant'}[a] ?? '').localeCompare(
        {hass:'Hass Group',external:'Other Tenant'}[b] ?? '')));
    assert.equal(ctx.actingOrgId,'hass','stale affiliate cookie falls back to parent tenant');
    const other = await resolveActingContext(h.db,'hass','Hass Group','hass',true,'external');
    assert.equal(other.actingOrgId,'external','owner can switch to another root tenant');
    const member = await resolveActingContext(h.db,'hass','Hass Group','hass',false,'external');
    assert.equal(member.actingOrgId,'hass','ordinary users cannot switch tenant');
    const childOwner = await resolveActingContext(h.db,'kenya','Hass Kenya','hpk',true,null);
    assert.equal(childOwner.actingOrgId,'hass','platform owner whose home account is an affiliate resolves to parent');
  } finally { h.close(); }
});

test('station/region affiliate links stay under Hass even when reclassified', async () => {
  const h = harness();
  try {
    await runMigrations(h.db);
    await h.db.batch(seed,'write');
    const created = await createRegion(h.db,admin,{name:'Coast',affiliateOrgId:'kenya'});
    assert.equal(created.ok,true);
    if (!created.ok) return;
    const stationInput = {
      name:'Coastal Depot',affiliateOrgId:'kenya',regionId:created.id,
      address:null,stationManagerId:null,isBase:false,status:'ACTIVE',
    };
    const mismatch = await createStation(h.db,admin,{...stationInput, affiliateOrgId:'uganda'});
    assert.equal(mismatch.ok,false,'cross-affiliate region must be rejected');
    const foreign = await createStation(h.db,admin,{...stationInput,affiliateOrgId:'external'});
    assert.equal(foreign.ok,false,'unrelated tenant cannot be selected');
    const depot = await createStation(h.db,admin,stationInput);
    assert.equal(depot.ok,true);
    if (!depot.ok || !depot.id) return;
    const before = await getStation(h.db,'hass',depot.id);
    assert.equal(before?.affiliateOrgId,'kenya');
    assert.match(before?.code ?? '',/^STN-[0-9]{6}$/);
    assert.equal((await listStationsAdmin(h.db,'hass'))[0].affiliateName,'Hass Kenya');

    const move = await updateRegion(h.db,admin,created.id,{name:'Coast',affiliateOrgId:'uganda'});
    assert.equal(move.ok,true);
    const after = await getStation(h.db,'hass',depot.id);
    assert.equal(after?.affiliateOrgId,'uganda','linked stations follow region classification');
    assert.equal(after?.regionId,created.id);
    assert.equal(after?.code,before?.code);
    const row = await h.db.execute({sql:'SELECT org_id FROM stations WHERE id=?',args:[depot.id]});
    assert.equal(row.rows[0].org_id,'hass','tenant boundary must remain Hass');
    const reg = await getRegion(h.db,admin,created.id);
    assert.equal(reg?.orgId,'hass');
    assert.equal(reg?.affiliateOrgId,'uganda');
    const audit = await h.db.execute({
      sql:`SELECT before_json,after_json FROM audit_logs
           WHERE entity_type='station' AND action='stations.affiliate_reassigned' AND entity_id=?`,
      args:[depot.id],
    });
    assert.equal(audit.rows.length,1);
    assert.match(String(audit.rows[0].after_json),/uganda/);

    const changed = await updateStation(h.db,admin,depot.id,{
      ...stationInput,name:'Depot updated',regionId:null,affiliateOrgId:'kenya',
    });
    assert.equal(changed.ok,true,'station with no region may be independently reclassified');
    assert.equal((await getStation(h.db,'hass',depot.id))?.affiliateOrgId,'kenya');
  } finally { h.close(); }
});

test('affiliate creation does not create another tenant subscription; station total includes parent-owned assigned sites',async()=>{
  const h=harness();
  try {
    await runMigrations(h.db);
    await h.db.batch(seed,'write');
    const created = await createAffiliate(h.db,{groupId:'hass',userId:'admin'},{
      code:'FLT',name:'Fleet Tanzania',country:'TZ',baseCurrency:'TZS',
    });
    assert.equal(created.ok,true);
    const child = await h.db.execute(`SELECT id,parent_org_id FROM organisations WHERE slug='flt'`);
    assert.equal(child.rows[0].parent_org_id,'hass');
    const sub = await h.db.execute({
      sql:`SELECT COUNT(*) AS n FROM subscriptions WHERE org_id=?`,
      args:[String(child.rows[0].id)],
    });
    assert.equal(Number(sub.rows[0].n),0);
    const region = await createRegion(h.db,admin,{name:'Tanzania',affiliateOrgId:String(child.rows[0].id)});
    assert.equal(region.ok,true);
    if(!region.ok)return;
    const station = await createStation(h.db,admin,{
      name:'TZ Depot',affiliateOrgId:String(child.rows[0].id),regionId:region.id,
      address:null,stationManagerId:null,isBase:false,status:'ACTIVE',
    });
    assert.equal(station.ok,true);
    const items = await listAffiliates(h.db,'hass');
    assert.equal(items.find(a=>a.slug==='flt')?.stationCount,1);
    const roots = await resolveActingContext(h.db,'hass','Hass Group','hass',true,null);
    assert.ok(!roots.switchable.some(x=>x.id === String(child.rows[0].id)));
  } finally {h.close();}
});

test('affiliate form keeps five fields on a single desktop row with responsive fallbacks',()=>{
  const css=readFileSync(new URL('../src/styles/engr.css',import.meta.url),'utf8');
  const form=readFileSync(new URL('../src/pages/engr/admin/affiliates/[id].astro',import.meta.url),'utf8');
  assert.match(form,/engr-formgrid--affiliate/);
  assert.match(css,/repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(css,/repeat\(2, minmax\(0, 1fr\)\)/);
});
