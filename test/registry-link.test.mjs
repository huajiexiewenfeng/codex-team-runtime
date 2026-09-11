import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as runtime from '../src/runtime.mjs';
import * as projection from '../src/registry-projection.mjs';
import * as adapter from '../src/registry-adapter.mjs';
import { initialize, readState, transact } from '../src/store.mjs';
import { initReporting } from '../src/reporting-store.mjs';

const at = n => new Date(Date.UTC(2026, 8, 10, 0, n)).toISOString();
const source = { kind: 'fixture', ref: 'registry-link' };
const member = (id, role, threadId = `thread-${id}`) => ({
 id, role, name: id, lifecycle: 'active',
 binding: { status: 'bound', hostId: 'host', threadId }
});
const caller = id => ({ hostId: 'host', threadId: `thread-${id}` });
function legacy() {
 return runtime.createState({
  teamId: 'team', name: 'Team', source,
  members: [member('manager','Manager'), member('liaison','Liaison'), member('worker','Worker')]
 }, at(0));
}
function registry(path) {
 return {
  registryId: 'registry', registryPath: resolve(path), teamId: 'team', migrationId: 'migration',
  sourceSha256: 'a'.repeat(64), sourceVersion: 0, phase: 'prepared', teamRevision: 0,
  readyMemberIds: []
 };
}
function exported(state, overrides = {}) {
 return {
  registryId: state.registry.registryId, teamId: state.team.id, teamRevision: 7,
  migrationId: state.registry.migrationId, statePath: state.__statePath,
  members: structuredClone(state.members), readyMemberIds: state.members.map(m => m.id),
  ...overrides
 };
}
function event(state, type, data = {}, n = state.version + 1, actor = 'manager') {
 return runtime.evolve(state, { id:`e-${state.version}-${type}`, type, actor, at:at(n), source, ...data }, state.version);
}

test('prepare creates an exact schema-2 fence and rejects ordinary writes without changing history', () => {
 const before = legacy(), link = registry('registry.json');
 const prepared = adapter.adaptRegistryRequest({ action:'prepare', state:before, registry:link });
 assert.equal(prepared.schemaVersion, 2);
 assert.deepEqual(prepared.registry, link);
 assert.deepEqual(prepared.events, before.events);
 assert.deepEqual(prepared.rounds, before.rounds);
 assert.deepEqual(prepared.tasks, before.tasks);
 assert.throws(() => event(prepared, 'openRound', { roundId:'round', title:'Round' }), /prepared/i);
 assert.throws(() => runtime.validate({ ...prepared, surprise:true }), /unknown field/i);
 const changed=event(legacy(),'openRound',{roundId:'existing',title:'Existing'});
 assert.throws(()=>adapter.adaptRegistryRequest({action:'prepare',state:changed,registry:link}),/source version/i);
 const activeLink={...link,phase:'active',teamRevision:1,readyMemberIds:['manager','liaison','worker']};
 assert.throws(()=>adapter.adaptRegistryRequest({action:'prepare',state:before,registry:activeLink}),/prepared/i);
});

test('projection validates exact link and state path and never mutates operational history', () => {
 const statePath = resolve('state.json');
 const prepared = adapter.adaptRegistryRequest({ action:'prepare', state:legacy(), registry:registry('registry.json') });
 prepared.__statePath = statePath;
 const before = structuredClone(prepared); delete before.__statePath;
 const value = exported(prepared);
 const active = adapter.adaptRegistryRequest({ action:'activate', state:before, projection:value }, { statePath });
 assert.equal(active.registry.phase, 'active');
 assert.equal(active.registry.teamRevision, 7);
 assert.deepEqual(active.events, before.events);
 assert.deepEqual(active.rounds, before.rounds);
 assert.deepEqual(active.tasks, before.tasks);
 for (const bad of [
  { ...value, extra:true }, { ...value, registryId:'other' }, { ...value, teamId:'other' },
  { ...value, migrationId:'other' }, { ...value, statePath:resolve('other.json') },
  { ...value, teamRevision:0 }, { ...value, readyMemberIds:['worker','worker'] }
 ]) assert.throws(() => projection.applyRegistryProjection(before, bad, statePath));
 const colliding=adapter.adaptRegistryRequest({action:'prepare',state:legacy(),registry:registry(statePath)});
 assert.throws(()=>projection.applyRegistryProjection(colliding,value,statePath),/separate|same/i);
 const adapterCollision={...value,registryId:colliding.registry.registryId,migrationId:colliding.registry.migrationId,statePath:colliding.registry.registryPath};
 assert.throws(()=>adapter.adaptRegistryRequest({action:'activate',state:colliding,projection:adapterCollision}),/separate|same/i);
});

test('projection rejects disappeared, changed-role, changed-binding and revived cached members', () => {
 const statePath = resolve('state.json');
 let prepared = adapter.adaptRegistryRequest({ action:'prepare', state:legacy(), registry:registry('registry.json') });
 const base = exported({ ...prepared, __statePath:statePath });
 const variants = [
  base.members.slice(0, -1),
  base.members.map(m => m.id==='worker' ? { ...m, role:'Liaison' } : m),
  base.members.map(m => m.id==='worker' ? { ...m, binding:{ ...m.binding, threadId:'changed' } } : m)
 ];
 for (const members of variants) assert.throws(() => projection.applyRegistryProjection(prepared, { ...base, members }, statePath));
 prepared.members[2].lifecycle = 'exited';
 assert.throws(() => projection.applyRegistryProjection(prepared, base, statePath), /lifecycle|reviv/i);
 const exited = { ...base, members:base.members.map(m => m.id==='worker' ? { ...m, lifecycle:'exited' } : m) };
 assert.equal(projection.applyRegistryProjection(adapter.adaptRegistryRequest({ action:'prepare', state:legacy(), registry:registry('registry.json') }), exited, statePath).members[2].lifecycle, 'exited');
 const reordered={...base,teamRevision:8,members:base.members.map(m=>({...m,binding:{threadId:m.binding.threadId,hostId:m.binding.hostId,status:m.binding.status}}))};
 let active=projection.applyRegistryProjection(adapter.adaptRegistryRequest({action:'prepare',state:legacy(),registry:registry('registry.json')}),base,statePath);
 active=event(active,'openRound',{roundId:'round',title:'Round'});
 active=projection.applyRegistryProjection(active,reordered,statePath);
 assert.doesNotThrow(()=>event(active,'assign',{caller:caller('manager'),roundId:'round',taskId:'task',title:'Task',workerId:'worker',required:true,assignedAt:at(2)},2));
});

test('linked readiness gates actors, leader and selected Workers without weakening queue or ownership rules', () => {
 const statePath = resolve('state.json');
 const prepared = adapter.adaptRegistryRequest({ action:'prepare', state:legacy(), registry:registry('registry.json') });
 const base = exported({ ...prepared, __statePath:statePath });
 const active = projection.applyRegistryProjection(prepared, base, statePath);
 const without = (state,ids) => projection.applyRegistryProjection(state, { ...base, teamRevision:state.registry.teamRevision + 1, members:state.members, readyMemberIds:ids }, statePath);
 assert.throws(() => event(without(active,['liaison','worker']), 'openRound', { roundId:'round', title:'Round' }), /actor.*ready|manager.*ready|leader.*ready/i);
 let open = event(active, 'openRound', { roundId:'round', title:'Round' });
 assert.throws(() => event(without(open,['manager','liaison']), 'assign', { caller:caller('manager'), roundId:'round', taskId:'task', title:'Task', workerId:'worker', required:true, assignedAt:at(2) }, 2), /worker.*ready/i);
 open = event(open, 'enqueue', { caller:caller('manager'), roundId:'round', taskId:'queued', title:'Queued', workerId:'worker', required:true, assignedAt:null }, 2);
 assert.throws(() => event(open, 'assign', { caller:caller('manager'), roundId:'round', taskId:'jump', title:'Jump', workerId:'worker', required:true, assignedAt:at(3) }, 3), /queue/i);
 assert.throws(() => event(open, 'submit', { roundId:'round', taskId:'queued', summary:'bad' }, 3, 'liaison'), /Manager action|ownership/i);
});

test('explicit admission appends a ready Registry Worker snapshot and preserves old work', () => {
 const statePath = resolve('state.json');
 const prepared = adapter.adaptRegistryRequest({ action:'prepare', state:legacy(), registry:registry('registry.json') });
 const newcomer = member('new-worker','Worker');
 const initial = exported({ ...prepared, __statePath:statePath });
 let active = projection.applyRegistryProjection(prepared, initial, statePath);
 active = event(active, 'openRound', { roundId:'round', title:'Round' });
 active = event(active, 'assign', { caller:caller('manager'), roundId:'round', taskId:'old-task', title:'Old', workerId:'worker', required:true, assignedAt:at(2) }, 2);
 const base = { ...initial, teamRevision:8, members:[...prepared.members,newcomer], readyMemberIds:['manager','liaison','worker','new-worker'] };
 active = projection.applyRegistryProjection(active, base, statePath);
 const oldMembers = structuredClone(active.rounds[0].members), oldTasks = structuredClone(active.tasks);
 const admitted = event(active, 'admitRegistryMember', { caller:caller('manager'), roundId:'round', memberId:'new-worker' }, 3);
 assert.deepEqual(admitted.rounds[0].members.slice(0, oldMembers.length), oldMembers);
 assert.deepEqual(admitted.rounds[0].members.at(-1), newcomer);
 assert.deepEqual(admitted.tasks, oldTasks);
 assert.throws(() => event(admitted, 'admitRegistryMember', { caller:caller('manager'), roundId:'round', memberId:'new-worker' }, 4));
 assert.throws(() => event(active, 'registerWorker', { caller:caller('manager'), memberId:'x', name:'x', binding:caller('new-worker') }, 3), /legacy identity/i);
 const corrupt=structuredClone(admitted);delete corrupt.events.at(-1).memberId;
 assert.throws(()=>runtime.validate(corrupt),/member|nonempty/i);
 const unrelated=structuredClone(active);unrelated.events[0].memberId='new-worker';
 assert.throws(()=>runtime.validate(unrelated),/unknown field/i);
});

test('check_exit refuses open-round participants', () => {
 let state = event(legacy(), 'openRound', { roundId:'round', title:'Round' });
 assert.throws(() => adapter.adaptRegistryRequest({ action:'check_exit', state, memberId:'worker' }), /open round/i);
 assert.deepEqual(adapter.adaptRegistryRequest({ action:'check_exit', state, memberId:'missing' }), { allowed:true });
});

test('store linked reads project through injected exporter and unavailable Registry leaves bytes unchanged', async () => {
 const dir = await mkdtemp(join(tmpdir(),'registry-link-'));
 const statePath = join(dir,'state.json'), registryPath = join(dir,'registry.json');
 const prepared = adapter.adaptRegistryRequest({ action:'prepare', state:legacy(), registry:registry(registryPath) });
 const value = exported({ ...prepared, __statePath:resolve(statePath) });
 const active = projection.applyRegistryProjection(prepared,value,resolve(statePath));
 await initialize(statePath, active);
 const before = await readFile(statePath,'utf8');
 const projected = await readState(statePath, { exporter:async () => value });
 assert.equal(projected.registry.phase, 'active');
 assert.equal(await readFile(statePath,'utf8'), before);
 await assert.rejects(transact(statePath, 0, { id:'open', type:'openRound', actor:'manager', at:at(1), source, roundId:'round', title:'Round' }, { exporter:async () => { throw new Error('Registry unavailable'); } }), /Registry unavailable/);
 assert.equal(await readFile(statePath,'utf8'), before);
 const fencedPath=join(dir,'prepared.json');await initialize(fencedPath,prepared);
 await assert.rejects(readState(fencedPath,{exporter:async()=>value}),/prepared/i);
});

test('snapshot exposes revision context but not local Registry or state paths', () => {
 const statePath = resolve('secret-state.json');
 const prepared = adapter.adaptRegistryRequest({ action:'prepare', state:legacy(), registry:registry('secret-registry.json') });
 const active = projection.applyRegistryProjection(prepared, exported({ ...prepared, __statePath:statePath }), statePath);
 const view = runtime.snapshot(active, at(1));
 assert.deepEqual(view.registry, { registryId:'registry', migrationId:'migration', phase:'active', teamRevision:7, readyMemberIds:['manager','liaison','worker'] });
 assert.doesNotMatch(JSON.stringify(view), /secret-(?:registry|state)\.json/);
});

test('exporter uses the fixed bounded argv without a shell and fails closed', async () => {
 const statePath=resolve('state.json'),prepared=adapter.adaptRegistryRequest({action:'prepare',state:legacy(),registry:registry('registry.json')});
 const value=exported({...prepared,__statePath:statePath});
 const active=projection.applyRegistryProjection(prepared,value,statePath);let call;
 const execFile=async(...args)=>{call=args;return {stdout:JSON.stringify({...value,teamRevision:8})};};
 const refreshed=await projection.exportRegistryProjection(active,statePath,{python:'trusted-python',execFile});
 assert.equal(refreshed.registry.teamRevision,8);
 assert.deepEqual(call[0],'trusted-python');
 assert.deepEqual(call[1],['-I','-X','utf8','-m','codex_team_context.runtime_link','export','--registry',active.registry.registryPath,'--team','team']);
 assert.deepEqual(call[2],{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:4*1024*1024,shell:false});
 await assert.rejects(projection.exportRegistryProjection(active,statePath,{python:'x',execFile:async()=>({stdout:'not-json'})}),/invalid JSON/i);
 await assert.rejects(projection.exportRegistryProjection(active,statePath,{python:'x',execFile:async()=>{throw new Error('exit 2');}}),/exporter failed.*exit 2/i);
 await assert.rejects(projection.exportRegistryProjection(active,statePath,{python:''}),/CODEX_TEAM_CONTEXT_PYTHON/);
});

test('cross-store guard holds Registry then state then reporting locks and never steals a busy lock', async () => {
 const dir=await mkdtemp(join(tmpdir(),'registry-locks-')),statePath=join(dir,'state.json'),registryPath=join(dir,'registry.json'),reportingPath=join(dir,'reporting.json');
 const prepared=adapter.adaptRegistryRequest({action:'prepare',state:legacy(),registry:registry(registryPath)});
 const value=exported({...prepared,__statePath:resolve(statePath)}),active=projection.applyRegistryProjection(prepared,value,resolve(statePath));
 await initialize(statePath,active);const before=await readFile(statePath,'utf8');
 await assert.rejects(initReporting(reportingPath,statePath,caller('manager'),at(1),{exporter:async()=>{
  await Promise.all([access(`${registryPath}.lock`),access(`${statePath}.lock`),access(`${reportingPath}.lock`)]);
  throw new Error('observed ordered guard');
 }}),/observed ordered guard/);
 assert.equal(await readFile(statePath,'utf8'),before);
 const busy=await import('node:fs/promises').then(fs=>fs.open(`${registryPath}.lock`,'wx'));
 try {await assert.rejects(transact(statePath,0,{id:'x'}, {exporter:async()=>value}),error=>error.code==='EEXIST');}
 finally {await busy.close();await import('node:fs/promises').then(fs=>fs.unlink(`${registryPath}.lock`));}
 assert.equal(await readFile(statePath,'utf8'),before);
});

test('adapter CLI reads exactly one JSON request and reports failures on stderr', () => {
 const ok=spawnSync(process.execPath,['src/registry-adapter.mjs'],{cwd:resolve('.'),encoding:'utf8',input:JSON.stringify({action:'inspect',state:legacy()}),windowsHide:true});
 assert.equal(ok.status,0,ok.stderr);assert.deepEqual(JSON.parse(ok.stdout),legacy());assert.equal(ok.stderr,'');
 const bad=spawnSync(process.execPath,['src/registry-adapter.mjs'],{cwd:resolve('.'),encoding:'utf8',input:JSON.stringify({action:'inspect',state:legacy(),extra:true}),windowsHide:true});
 assert.notEqual(bad.status,0);assert.match(bad.stderr,/fields mismatch/i);assert.equal(bad.stdout,'');
});
