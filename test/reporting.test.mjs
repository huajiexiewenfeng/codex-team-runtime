import test from 'node:test';
import assert from 'node:assert/strict';
import { createState,evolve } from '../src/runtime.mjs';
import { mkdtemp,readFile,writeFile,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,dirname,basename } from 'node:path';
import { initialize } from '../src/store.mjs';
const storage=await import('../src/reporting-store.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const api=await import('../src/reporting.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const m={hostId:'local-fixture',threadId:'manager-fixture'},l={hostId:'local-fixture',threadId:'liaison-fixture'},owner={memberId:'l',...l};
const at=n=>new Date(Date.UTC(2026,8,6,0,n)).toISOString();
const evidence={kind:'host-observation',evidenceRef:'offline-test-of-declared-host-result'};
export function setup(kind='manual') {
 const source={kind,ref:'offline-ledger-test'};
 let s=createState({teamId:'fixture-team',name:'Fixture',source,members:[{id:'m',name:'M',role:'Manager',lifecycle:'active',binding:{status:'bound',...m}},{id:'l',name:'L',role:'Liaison',lifecycle:'active',binding:{status:'unbound'}},{id:'w',name:'W',role:'Worker',lifecycle:'active',binding:{status:'bound',hostId:'local-fixture',threadId:'worker-fixture'}}]},at(0));
 s=evolve(s,{id:'invite',type:'attachInvite',actor:'m',at:at(1),source,caller:m,target:l,expiresAt:at(20)},s.version);
 s=evolve(s,{id:'confirm',type:'attachConfirm',actor:'l',at:at(2),source,caller:l,invitationId:'invite',invitationVersion:1},s.version);
 s=evolve(s,{id:'open',type:'openRound',actor:'m',at:at(3),source,roundId:'r',title:'Round'},s.version);
 return s;
}
function functions(){assert.equal(typeof api.createReportingLedger,'function','reporting capability missing');return api;}
function make(s=setup()){const f=functions();return {s,b:f.createReportingLedger(s,m,at(4)),f};}
function apply(x,event){x.b=x.f.evolveReporting(x.b,x.s,m,event,x.b.version);return x.b;}
const prepare=(id='op-create',n=5)=>({id,type:'prepare',at:at(n),expiresAt:at(n+10),source:evidence});
const dispatch=(operationId='op-create',n=6)=>({id:`dispatch-${operationId}`,type:'dispatch',at:at(n),operationId,source:evidence});
const record=(outcome,patch={})=>({id:`record-${outcome}`,type:'record',at:at(7),observedAt:at(7),operationId:'op-create',owner,automationId:'automation-fixture',outcome,source:evidence,...patch});
test('paired init creates only projection and prepare/dispatch/record does not change business state',()=>{
 const x=make(),before=structuredClone(x.s);assert.equal(x.b.version,0);assert.equal(x.f.planReporting(x.s,x.b,m,at(4)).kind,'CREATE');
 apply(x,prepare());assert.equal(x.b.operations[0].phase,'PREPARED');apply(x,dispatch());apply(x,record('running'));
 assert.equal(x.b.automationId,'automation-fixture');assert.equal(x.f.planReporting(x.s,x.b,m,at(8)).kind,'NONE');assert.equal(x.s.reporting.actual,'unknown');assert.deepEqual(x.s,before);
});
test('unknown create blocks repeated creation and opposite change until exact observation resolves',()=>{
 const x=make();apply(x,prepare());apply(x,dispatch());apply(x,record('unknown',{automationId:null}));
 x.s=evolve(x.s,{id:'off',type:'reports',actor:'m',at:at(8),source:{kind:'manual',ref:'fixture'},enabled:false},x.s.version);
 assert.equal(x.f.planReporting(x.s,x.b,m,at(8)).kind,'RECONCILE');assert.throws(()=>apply(x,prepare('op-again',8)));
 apply(x,record('running',{id:'resolved',at:at(9),observedAt:at(9)}));assert.equal(x.f.planReporting(x.s,x.b,m,at(9)).kind,'PAUSE');
});
test('late old pause observation is recorded but cannot overwrite renewed business intent',()=>{
 const x=make();apply(x,prepare());apply(x,dispatch());apply(x,record('running'));
 x.s=evolve(x.s,{id:'off',type:'reports',actor:'m',at:at(8),source:{kind:'manual',ref:'fixture'},enabled:false},x.s.version);
 apply(x,prepare('pause',8));apply(x,dispatch('pause',9));
 x.s=evolve(x.s,{id:'on',type:'reports',actor:'m',at:at(10),source:{kind:'manual',ref:'fixture'},enabled:true},x.s.version);
 const before=structuredClone(x.s);apply(x,record('stopped',{id:'late-pause',operationId:'pause',at:at(11),observedAt:at(11)}));
 assert.deepEqual(x.s,before);assert.equal(x.f.planReporting(x.s,x.b,m,at(11)).kind,'RESUME');
});
test('stale or expired prepared operations cannot dispatch and may be superseded',()=>{
 const x=make();apply(x,prepare());assert.throws(()=>apply(x,dispatch('op-create',15)),/expired|stale/i);
 apply(x,prepare('replacement',16));assert.equal(x.b.operations[0].phase,'SUPERSEDED');assert.equal(x.b.operations[1].phase,'PREPARED');
 x.s=evolve(x.s,{id:'off',type:'reports',actor:'m',at:at(17),source:{kind:'manual',ref:'fixture'},enabled:false},x.s.version);
 assert.throws(()=>apply(x,dispatch('replacement',17)),/expired|stale/i);
 apply(x,prepare('supersede-off',18));assert.equal(x.f.planReporting(x.s,x.b,m,at(18)).kind,'NONE');
});
test('failed or fixture observations never silently retry or claim live stop; duplicates reject',()=>{
 const x=make();apply(x,prepare());apply(x,dispatch());apply(x,record('failed'));
 assert.equal(x.f.planReporting(x.s,x.b,m,at(8)).kind,'FAILED');assert.throws(()=>apply(x,prepare('retry',8)));assert.throws(()=>apply(x,record('failed')));
 const y=make();apply(y,prepare());apply(y,dispatch());apply(y,record('stopped',{source:{kind:'fixture',evidenceRef:'simulated'}}));
 assert.equal(y.b.observation,null);assert.equal(y.b.automationId,null);assert.equal(y.f.planReporting(y.s,y.b,m,at(8)).kind,'RECONCILE');
});
test('rejects wrong team, owner, caller, version, automation id and unpaired init',()=>{
 const x=make();assert.throws(()=>x.f.planReporting({...x.s,team:{...x.s.team,id:'other'}},x.b,m,at(4)));assert.throws(()=>x.f.planReporting(x.s,x.b,l,at(4)));
 const unpaired=setup();delete unpaired.session;assert.throws(()=>x.f.createReportingLedger(unpaired,m,at(4)));
 assert.throws(()=>x.f.evolveReporting(x.b,x.s,m,prepare(),99));apply(x,prepare());apply(x,dispatch());
 assert.throws(()=>apply(x,record('running',{owner:{...owner,threadId:'wrong'}})));assert.throws(()=>apply(x,record('running',{operationId:'wrong'})));
 apply(x,record('unknown'));assert.throws(()=>apply(x,record('running',{automationId:'different'})));
});
test('reporting storage initializes exclusively, CAS serializes writes and corrupt ledger never overwrites',async t=>{
 assert.equal(typeof storage.initReporting,'function','reporting storage missing');
 const dir=await mkdtemp(join(tmpdir(),'reporting-ledger-'));
 t.after(async()=>{const target=await realpath(dir);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('reporting-ledger-'));await rm(target,{recursive:true,force:true});});
 const statePath=join(dir,'state.json'),path=join(dir,'reporting.json'),state=setup();await initialize(statePath,state);const business=await readFile(statePath,'utf8');
 await storage.initReporting(path,statePath,m,at(4));await assert.rejects(storage.initReporting(path,statePath,m,at(4)));
 const results=await Promise.allSettled([storage.transactReporting(path,statePath,m,prepare(),0),storage.transactReporting(path,statePath,m,prepare('other'),0)]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await storage.readReporting(path)).version,1);assert.equal(await readFile(statePath,'utf8'),business);
 const before=await readFile(path,'utf8');await assert.rejects(storage.transactReporting(path,statePath,m,dispatch(),0));assert.equal(await readFile(path,'utf8'),before);
 await writeFile(path,'{broken');await assert.rejects(storage.transactReporting(path,statePath,m,dispatch(),1));assert.equal(await readFile(path,'utf8'),'{broken');
});
test('storage dispatch rereads changed business intent before writing',async t=>{
 assert.equal(typeof storage.initReporting,'function','reporting storage missing');
 const dir=await mkdtemp(join(tmpdir(),'reporting-ledger-'));
 t.after(async()=>{const target=await realpath(dir);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('reporting-ledger-'));await rm(target,{recursive:true,force:true});});
 const path=join(dir,'reporting.json'),statePath=join(dir,'state.json');let s=setup();await initialize(statePath,s);await storage.initReporting(path,statePath,m,at(4));await storage.transactReporting(path,statePath,m,prepare(),0);
 s=evolve(s,{id:'off',type:'reports',actor:'m',at:at(6),source:{kind:'manual',ref:'fixture'},enabled:false},s.version);await writeFile(statePath,JSON.stringify(s));
 const before=await readFile(path,'utf8');await assert.rejects(storage.transactReporting(path,statePath,m,dispatch(),1),/stale/);assert.equal(await readFile(path,'utf8'),before);
});
test('unknown dispatch never expires into retry; fixture business state cannot promote host labels',()=>{
 const x=make();apply(x,prepare());apply(x,dispatch());assert.equal(x.f.planReporting(x.s,x.b,m,at(59)).kind,'RECONCILE');
 const y=make(setup('fixture'));apply(y,prepare());apply(y,dispatch());apply(y,record('stopped'));assert.equal(y.b.observation,null);assert.equal(y.b.automationId,null);assert.equal(y.f.planReporting(y.s,y.b,m,at(8)).kind,'RECONCILE');
});
test('exited Liaison yields PAUSE and exited Manager cannot change ledger',()=>{
 const x=make();apply(x,prepare());apply(x,dispatch());apply(x,record('running'));
 // Role lifecycle is input truth; no attempt to bypass business exit constraints.
 x.s=structuredClone(x.s);x.s.members.find(v=>v.id==='l').lifecycle='exited';assert.equal(x.f.planReporting(x.s,x.b,m,at(8)).kind,'PAUSE');
 x.s.members.find(v=>v.id==='m').lifecycle='exited';assert.throws(()=>apply(x,prepare('cleanup',8)),/Manager/);
});
test('corrupt phase or invented automation tracking is rejected before use',()=>{
 const x=make();apply(x,prepare());apply(x,dispatch());
 const forged=structuredClone(x.b);forged.operations[0].phase='CONFIRMED';assert.throws(()=>x.f.validateReportingLedger(forged));
 const fakeId=structuredClone(x.b);fakeId.automationId='invented';assert.throws(()=>x.f.validateReportingLedger(fakeId));
});
test('import cannot erase a confirmed CREATE automation identity across all matching projections',async t=>{
 const x=make();apply(x,prepare());apply(x,dispatch());apply(x,record('running'));
 const corrupted=structuredClone(x.b);
 corrupted.automationId=null;corrupted.observation.automationId=null;
 corrupted.operations[0].records[0].automationId=null;corrupted.events.at(-1).automationId=null;
 assert.throws(()=>x.f.validateReportingLedger(corrupted),/automation identity/i);
 assert.throws(()=>x.f.planReporting(x.s,corrupted,m,at(8)),/automation identity/i);
 const dir=await mkdtemp(join(tmpdir(),'reporting-ledger-'));
 t.after(async()=>{const target=await realpath(dir);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('reporting-ledger-'));await rm(target,{recursive:true,force:true});});
 const path=join(dir,'reporting.json'),statePath=join(dir,'state.json');
 await initialize(statePath,x.s);const business=await readFile(statePath,'utf8');
 const bytes=JSON.stringify(corrupted);await writeFile(path,bytes);
 await assert.rejects(storage.readReporting(path),/automation identity/i);
 await assert.rejects(storage.transactReporting(path,statePath,m,prepare('duplicate-create',8),corrupted.version),/automation identity/i);
 assert.equal(await readFile(path,'utf8'),bytes);assert.equal(await readFile(statePath,'utf8'),business);
});
test('import cannot drop dispatch or receipt history from operation projection',()=>{
 const x=make();apply(x,prepare());apply(x,dispatch());
 const hiddenDispatch=structuredClone(x.b);hiddenDispatch.operations[0].dispatchedAt=null;hiddenDispatch.operations[0].phase='SUPERSEDED';
 assert.throws(()=>x.f.validateReportingLedger(hiddenDispatch),/Dispatch history/);
 apply(x,record('running'));const hiddenReceipt=structuredClone(x.b);hiddenReceipt.operations[0].records=[];hiddenReceipt.operations[0].phase='DISPATCHED';
 assert.throws(()=>x.f.validateReportingLedger(hiddenReceipt),/Record history/);
});
