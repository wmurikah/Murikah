import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { runMigrations } from '../db/migrate.ts';
import { createAsset, updateAsset, listAssetMovements } from '../src/lib/engr/repos/adminAssets.ts';
import { createRegion, getRegion, listRegionsAdmin } from '../src/lib/engr/repos/adminRegions.ts';
import { createStation, updateStation, getStation } from '../src/lib/engr/repos/adminStations.ts';
import {
  requestTransfer, transitionTransfer, getTransfer, availableTransferActions,
  type TransferActor,
} from '../src/lib/engr/repos/assetTransfers.ts';

const manager = (userId: string): TransferActor => ({
  orgId: 'o', userId, roles: ['STATION_MANAGER'],
  perms: ['assets.transfer.request','assets.transfer.dispatch','assets.transfer.receive'],
});
const approver = (userId: string): TransferActor => ({
  orgId: 'o', userId, roles: ['ENGINEERING_MANAGER'],
  perms: ['assets.transfer.request','assets.transfer.approve','assets.transfer.dispatch','assets.transfer.receive'],
});

test('physical custody changes only at independent receipt, with full audit and paused PM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engr-transfer-'));
  const db = createClient({ url: `file:${join(dir, 'test.db')}` });
  try {
    await runMigrations(db);
    await db.batch([
      `INSERT INTO organisations (id,name,slug) VALUES ('o','Kenya','kenya')`,
      `INSERT INTO users (id,org_id,full_name,email) VALUES ('sender','o','Source Manager','sender@example.test')`,
      `INSERT INTO users (id,org_id,full_name,email) VALUES ('receiver','o','Destination Manager','receiver@example.test')`,
      `INSERT INTO users (id,org_id,full_name,email) VALUES ('checker','o','Engineering Manager','checker@example.test')`,
      `INSERT INTO stations (id,org_id,code,name,station_manager_id) VALUES ('s1','o','OLD1','Station One','sender')`,
      `INSERT INTO stations (id,org_id,code,name,station_manager_id) VALUES ('s2','o','OLD2','Station Two','receiver')`,
    ], 'write');
    const input = { tag: 'P-100', name: 'Pump', stationId: 's1', categoryId: null, manufacturer: null,
      model: null, serialNo: 'SN-123', installDate: null, status: 'IN_SERVICE' };
    const added = await createAsset(db, {orgId:'o',userId:'checker'}, input);
    assert.equal(added.ok, true);
    if (!added.ok || !added.id) return;
    const assetId = added.id;
    await db.execute({
      sql: `INSERT INTO pm_schedules (id,org_id,name,asset_id,station_id,status) VALUES ('pm1','o','Pump PM',?,'s1','ACTIVE')`,
      args: [assetId],
    });
    await db.execute({
      sql: `INSERT INTO service_requests (id,org_id,request_no,station_id,asset_id,raised_by,issue)
            VALUES ('req1','o','SR-1','s1',?,'sender','Breakdown')`,
      args: [assetId],
    });
    const held = await requestTransfer(db, manager('sender'), {assetId,toStationId:'s2',reason:'Replacement'});
    assert.equal(held.ok, false, 'open repairs prevent a physical transfer');
    await db.execute(`UPDATE service_requests SET status = 'CLOSED' WHERE id = 'req1'`);
    const requested = await requestTransfer(db, manager('sender'), { assetId, toStationId:'s2', reason:'Equipment relocation' });
    assert.equal(requested.ok, true);
    if (!requested.ok) return;
    const duplicate = await requestTransfer(db, manager('sender'), { assetId, toStationId:'s2', reason:'Again' });
    assert.equal(duplicate.ok, false, 'only one live transfer per asset');
    const oldStation = async () => String((await db.execute({
      sql: `SELECT station_id FROM assets WHERE id = ?`, args: [assetId],
    })).rows[0].station_id);
    assert.equal(await oldStation(), 's1');
    const bypass = await updateAsset(db, {orgId:'o',userId:'checker'}, assetId, { ...input, stationId:'s2', movementReason:'Bypass' });
    assert.equal(bypass.ok, false, 'direct location edit is forbidden');
    const selfApproval = await transitionTransfer(db, approver('sender'), requested.id, 'approve');
    assert.equal(selfApproval.ok, false, 'maker cannot approve own request');
    assert.equal((await transitionTransfer(db, approver('checker'), requested.id, 'approve')).ok, true);
    assert.equal(await oldStation(), 's1');
    assert.equal((await transitionTransfer(db, manager('sender'), requested.id, 'dispatch', {serial:'INVALID',condition:'Good'})).ok, false);
    assert.equal((await transitionTransfer(db, manager('sender'), requested.id, 'dispatch', {serial:'SN-123',condition:'Good'})).ok, true);
    assert.equal(await oldStation(), 's1');
    assert.equal((await transitionTransfer(db, approver('sender'), requested.id, 'receive', {serial:'SN-123',condition:'Good'})).ok, false);
    assert.equal((await transitionTransfer(db, manager('receiver'), requested.id, 'receive', {serial:'SN-123',condition:'Received intact'})).ok, true);
    assert.equal(await oldStation(), 's2');
    const pm = await db.execute(`SELECT status FROM pm_schedules WHERE id = 'pm1'`);
    assert.equal(String(pm.rows[0].status), 'PAUSED', 'active asset-specific PM must be reviewed');
    const history = await listAssetMovements(db,'o',assetId);
    assert.equal(history.length, 2);
    assert.equal(history[0].transferId, requested.id);
    assert.equal(history[0].fromStation, 'Station One');
    assert.equal(history[0].toStation, 'Station Two');
    const transfer = await getTransfer(db, manager('receiver'), requested.id);
    assert.equal(transfer?.status, 'RECEIVED');
    assert.deepEqual(transfer && availableTransferActions(manager('receiver'), transfer), []);
    const audit = await db.execute(`SELECT action FROM audit_logs WHERE entity_id = ? AND entity_type = 'asset_transfer'`, [requested.id]);
    assert.equal(audit.rows.length, 4);
  } finally {
    db.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('region affiliate ownership and immutable station/region codes are enforced server-side', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'engr-affiliates-'));
  const db = createClient({ url: `file:${join(dir,'test.db')}` });
  try {
    await runMigrations(db);
    await db.batch([
      `INSERT INTO organisations(id,name,slug) VALUES ('parent','Hass Group','hass')`,
      `INSERT INTO organisations(id,name,slug,parent_org_id,base_currency) VALUES ('child','Fleet Kenya','flk','parent','KES')`,
      `INSERT INTO organisations(id,name,slug,parent_org_id,base_currency) VALUES ('other','Hass Uganda','hpu','parent','UGX')`,
      `INSERT INTO users(id,org_id,full_name,email) VALUES ('owner','parent','Owner','owner@example.test')`,
    ],'write');
    const owner = {orgId:'parent',homeOrgId:'parent',userId:'owner',isPlatformOwner:true};
    const ordinary = {orgId:'child',homeOrgId:'child',userId:'owner',isPlatformOwner:false};
    const newRegion = await createRegion(db, owner, {name:'Nairobi',affiliateOrgId:'child'});
    assert.equal(newRegion.ok,true);
    if(!newRegion.ok)return;
    const region=await getRegion(db,owner,newRegion.id);
    assert.match(region?.code ?? '',/^REG-[0-9]{6}$/);
    assert.equal(region?.orgId,'child');
    assert.equal(region?.affiliateName,'Fleet Kenya');
    const unauthorized = await createRegion(db,ordinary,{name:'Foreign',affiliateOrgId:'other'});
    assert.equal(unauthorized.ok,false);
    assert.equal((await listRegionsAdmin(db,ordinary)).length,1);
    const edited = await (await import('../src/lib/engr/repos/adminRegions.ts')).updateRegion(db,owner,newRegion.id,{name:'Nairobi West',affiliateOrgId:'other'});
    assert.equal(edited.ok,true);
    assert.equal((await getRegion(db,owner,newRegion.id))?.orgId,'child');
    assert.equal((await getRegion(db,owner,newRegion.id))?.code,region?.code);
    const created = await createStation(db,{orgId:'child',userId:'owner'},{
      name:'Depot',regionId:newRegion.id,address:null,stationManagerId:null,isBase:false,status:'ACTIVE',
    });
    assert.equal(created.ok,true);
    if(!created.ok||!created.id)return;
    const station=await getStation(db,'child',created.id);
    assert.match(station?.code ?? '',/^STN-[0-9]{6}$/);
    const updated=await updateStation(db,{orgId:'child',userId:'owner'},created.id,{
      name:'Depot Renamed',regionId:newRegion.id,address:null,stationManagerId:null,isBase:false,status:'ACTIVE',
    });
    assert.equal(updated.ok,true);
    assert.equal((await getStation(db,'child',created.id))?.code,station?.code);
  } finally {
    db.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('PR445 navigation uses contextual item typing rather than invalid type predicates', () => {
  const layout = readFileSync(new URL('../src/layouts/EngrLayout.astro', import.meta.url),'utf8');
  assert.match(layout,/const visibleNavItems =/);
  assert.doesNotMatch(layout, /items: \[[\s\S]*?\]\.filter\(\(i\): i is NavItem/);
  assert.match(layout,/badgeKey: 'assetTransfers'/);
});
