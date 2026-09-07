import test from 'node:test';
import assert from 'node:assert/strict';
import { createState,evolve } from '../src/runtime.mjs';
import { createReportingLedger,evolveReporting } from '../src/reporting.mjs';
const api=await import('../src/reporting-tick.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const at=n=>new Date(Date.UTC(2026,8,7,0,n)).toISOString();
const m={hostId:'fixture-host',threadId:'fixture-manager'},l={hostId:'fixture-host',threadId:'fixture-liaison'};
const source={kind:'manual',ref:'offline-test-of-tick-contract'},evidence={kind:'host-observation',evidenceRef:'offline-test-declared-observation'};
function fixture(){
 let state=createState({teamId:'fixture-team',name:'Fixture',source,members:[{id:'m',name:'Manager',role:'Manager',lifecycle:'active',binding:{status:'bound',...m}},{id:'l',name:'Liaison',role:'Liaison',lifecycle:'active',binding:{status:'unbound'}},{id:'w',name:'Worker',role:'Worker',lifecycle:'active',binding:{status:'bound',hostId:'fixture-host',threadId:'fixture-worker'}}]},at(0));
 const event=e=>{state=evolve(state,{id:`business-${state.version}`,actor:'m',at:at(1),source,...e},state.version);};
 event({type:'attachInvite',caller:m,target:l,expiresAt:at(5)});event({type:'attachConfirm',actor:'l',caller:l,invitationId:'business-0',invitationVersion:1});event({type:'openRound',roundId:'r1',title:'Round'});
 let ledger=createReportingLedger(state,m,at(2));
 for(const e of [{id:'create',type:'prepare',at:at(3),expiresAt:at(10)},{id:'dispatch',type:'dispatch',at:at(4),operationId:'create'},{id:'running',type:'record',at:at(5),observedAt:at(5),operationId:'create',owner:{memberId:'l',...l},automationId:'known-automation',outcome:'running'}])ledger=evolveReporting(ledger,state,m,{...e,source:evidence},ledger.version);
 return {state,ledger};
}
function plan(state,ledger,caller=l,id='known-automation',asOf=at(20)){assert.equal(typeof api.planReportingTick,'function','reporting tick capability missing');return api.planReportingTick(state,ledger,caller,id,asOf);}
test('running paired owner receives read-only permission and canonical snapshot',()=>{
 const {state,ledger}=fixture(),before=structuredClone({state,ledger});const r=plan(state,ledger);
 assert.equal(r.allowProgressReport,true);assert.equal(r.reason,'running');assert.equal(r.recommendedAction,'none');assert.equal(r.readOnly,true);assert.equal(r.hostActionExecuted,false);assert.equal(r.identityAssurance,'caller-declared');assert.equal(r.snapshot.sourceVersion,state.version);assert.deepEqual({state,ledger},before);
});
test('user off, completed rounds and exited roles deny normal progress without pausing',()=>{
 const {state,ledger}=fixture();let off=evolve(state,{id:'off',type:'reports',actor:'m',at:at(6),source,enabled:false},state.version);
 assert.equal(plan(off,ledger).reason,'reports-disabled');
 let closed=structuredClone(state);closed=evolve(closed,{id:'assign',type:'assign',actor:'m',at:at(6),source,roundId:'r1',taskId:'t',title:'Task',workerId:'w',required:true,assignedAt:at(6)},closed.version);
 for(const [i,e] of [{type:'submit',actor:'w',summary:'Submitted'},{type:'review'},{type:'approve',summary:'Accepted',evidence:['fixture']},{type:'closeRound'}].entries())closed=evolve(closed,{id:`finish-${i}`,actor:'m',at:at(7),source,roundId:'r1',...(e.type==='closeRound'?{}:{taskId:'t'}),...e},closed.version);
 assert.equal(plan(closed,ledger).reason,'no-open-rounds');
 for(const id of ['m','l']){const exited=structuredClone(state);exited.members.find(x=>x.id===id).lifecycle='exited';const result=plan(exited,ledger);assert.equal(result.allowProgressReport,false);assert.equal(result.recommendedAction,'pause-or-reconcile');}
});
test('wrong owner, unknown automation, malformed identity and future state are rejected',()=>{
 assert.equal(typeof api.planReportingTick,'function');
 const {state,ledger}=fixture();assert.throws(()=>plan(state,ledger,m));assert.throws(()=>plan(state,ledger,l,'other'));assert.throws(()=>plan(state,ledger,{...l,verified:true}));assert.throws(()=>plan(state,ledger,l,'known-automation',at(0)));
 const wrong=structuredClone(ledger);wrong.teamId='different';assert.throws(()=>plan(state,wrong));
});
test('unknown dispatched change and permanent failure block reports while awaiting reconciliation',()=>{
 const {state,ledger}=fixture();const off=evolve(state,{id:'off',type:'reports',actor:'m',at:at(6),source,enabled:false},state.version);
 let pending=evolveReporting(ledger,off,m,{id:'pause',type:'prepare',at:at(7),expiresAt:at(12),source:evidence},ledger.version);
 pending=evolveReporting(pending,off,m,{id:'send-pause',type:'dispatch',at:at(8),operationId:'pause',source:evidence},pending.version);
 const renewed=evolve(off,{id:'renewed',type:'reports',actor:'m',at:at(9),source,enabled:true},off.version);
 assert.equal(plan(renewed,pending).reason,'operation-unresolved');
 for(const outcome of ['unknown','failed']){const observed=evolveReporting(pending,renewed,m,{id:`result-${outcome}`,type:'record',at:at(10),observedAt:at(10),operationId:'pause',owner:{memberId:'l',...l},automationId:'known-automation',outcome,source:evidence},pending.version);assert.equal(plan(renewed,observed).allowProgressReport,false);}
});
test('fixture source cannot authorize live progress and old tick uses current new round',()=>{
 const {state,ledger}=fixture();const simulated=structuredClone(state);simulated.team.source.kind='fixture';assert.equal(plan(simulated,ledger).reason,'fixture-source');
 const renewed=evolve(state,{id:'new-round',type:'openRound',actor:'m',at:at(6),source,roundId:'r2',title:'New round'},state.version);
 const result=plan(renewed,ledger);assert.equal(result.allowProgressReport,true);assert.equal(result.snapshot.rounds.length,2);assert.equal(result.sourceVersion,renewed.version);
});
test('stopped observation does not authorize a newly desired running report',()=>{
 const {state,ledger}=fixture();const off=evolve(state,{id:'off',type:'reports',actor:'m',at:at(6),source,enabled:false},state.version);
 let paused=ledger;
 for(const e of [{id:'pause',type:'prepare',at:at(7),expiresAt:at(12)},{id:'send',type:'dispatch',at:at(8),operationId:'pause'},{id:'stopped',type:'record',at:at(9),observedAt:at(9),operationId:'pause',owner:{memberId:'l',...l},automationId:'known-automation',outcome:'stopped'}])paused=evolveReporting(paused,off,m,{...e,source:evidence},paused.version);
 const renewed=evolve(off,{id:'on',type:'reports',actor:'m',at:at(10),source,enabled:true},off.version),before=structuredClone({renewed,paused});
 const r=plan(renewed,paused);assert.equal(r.allowProgressReport,false);assert.equal(r.reason,'running-not-observed');assert.deepEqual({renewed,paused},before);
});
