import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createState,evolve,validate,snapshot} from '../src/runtime.mjs';
import {initialize,readState} from '../src/store.mjs';
import {run} from '../src/cli.mjs';
const api=await import('../src/delivery.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const at=n=>new Date(Date.UTC(2026,8,7,0,n)).toISOString(),caller={hostId:'fixture',threadId:'manager'},source={kind:'fixture',ref:'offline-exact-delivery-evidence'};
function setup(){let s=createState({teamId:'t',name:'Team',source,members:[['m','Manager','manager'],['l','Liaison','liaison'],['w','Worker','worker']].map(([id,role,threadId])=>({id,name:role,role,lifecycle:'active',binding:{status:'bound',hostId:'fixture',threadId}}))},at(0));s=evolve(s,{id:'open',type:'openRound',actor:'m',at:at(1),source,roundId:'r',title:'Round'},0);return evolve(s,{id:'assign',type:'assign',actor:'m',at:at(2),source,roundId:'r',taskId:'t1',title:'Task',workerId:'w',required:true,assignedAt:at(2)},1);}
function event(s,type,data={},n=3){return evolve(s,{id:`e${s.version}`,type,actor:'m',caller,at:at(n),source,roundId:'r',taskId:'t1',...data},s.version);}
const checkData=(outcome='not-delivered',attemptId='assign')=>({outcome,attemptId,summary:'Exact evidence reviewed for this request'});
const checked=()=>event(setup(),'deliveryCheck',checkData());
function plan(s){assert.equal(typeof api.planDelivery,'function');return api.planDelivery(s,caller,'t1');}
async function fixture(t,s=setup()){const dir=await mkdtemp(join(tmpdir(),'delivery-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'state.json');await initialize(path,s);return {path,dir};}
test('legacy execution without delivery records is unknown and cannot be claimed',()=>{
 const s=setup(),before=JSON.stringify(s),p=plan(s);assert.equal(p.decision,'reconcile');assert.equal(p.delivery.status,'unknown');assert.equal(p.delivery.attemptId,'assign');assert.equal(p.hostRequest,null);assert.equal(p.executed,false);
 assert.throws(()=>event(s,'deliveryClaim',{attemptId:'assign',summary:'retry'}),/non-delivery|not-delivered/i);assert.equal(JSON.stringify(s),before);
});
test('verified non-delivery claims once and retains original task, timing and reporting',()=>{
 let s=checked();assert.equal(plan(s).decision,'ready-to-claim');const business=structuredClone({tasks:s.tasks,rounds:s.rounds,members:s.members,reporting:s.reporting});
 s=event(s,'deliveryClaim',{attemptId:'assign',summary:'One authorized retry'},4);const p=plan(s);assert.equal(p.decision,'reconcile');assert.equal(p.delivery.status,'unknown');assert.equal(p.delivery.attemptId,'e3');assert.equal(p.delivery.attempts,1);
 assert.deepEqual({tasks:s.tasks,rounds:s.rounds,members:s.members,reporting:s.reporting},business);
 assert.throws(()=>event(s,'deliveryClaim',{attemptId:'e3',summary:'duplicate'},5),/non-delivery|not-delivered/i);
 assert.equal(snapshot(s,at(5)).tasks[0].delivery.status,'unknown');
});
test('unknown result never grants retry; exact attempt may later be resolved delivered',()=>{
 let s=event(checked(),'deliveryClaim',{attemptId:'assign',summary:'retry'},4);
 s=event(s,'deliveryCheck',checkData('unknown','e3'),5);assert.equal(plan(s).decision,'reconcile');
 assert.throws(()=>event(s,'deliveryCheck',checkData('delivered','assign'),6),/attempt/i);
 s=event(s,'deliveryCheck',checkData('delivered','e3'),6);assert.equal(plan(s).decision,'supervise');
 assert.throws(()=>event(s,'deliveryCheck',checkData('not-delivered','e3'),7),/resolved|delivered/i);
 assert.throws(()=>event(s,'deliveryClaim',{attemptId:'e3',summary:'again'},7));
});
test('second proven non-delivery permits a new attempt without releasing Worker',()=>{
 let s=event(checked(),'deliveryClaim',{attemptId:'assign',summary:'retry'},4);s=event(s,'deliveryCheck',checkData('not-delivered','e3'),5);s=event(s,'deliveryClaim',{attemptId:'e3',summary:'retry after exact check'},6);
 assert.equal(plan(s).delivery.attempts,2);assert.equal(s.tasks[0].status,'executing');assert.equal(s.tasks.length,1);
});
test('recovery rejects wrong caller, mismatched worker source, pending binding and missing audit',()=>{
 for(const extra of [{caller:undefined},{caller:{hostId:'fixture',threadId:'liaison'}},{actor:'w'},{source:{kind:'host-observation',ref:'wrong',hostId:'fixture',threadId:'other'}}])assert.throws(()=>event(setup(),'deliveryCheck',{...checkData(),...extra}));
 const missing=setup();missing.events[1].type='observe';assert.equal(plan(missing).decision,'unavailable');assert.throws(()=>event(missing,'deliveryCheck',checkData()),/assignment|attempt/i);
 const wrong=setup();wrong.members.find(m=>m.id==='w').binding.threadId='changed';assert.throws(()=>plan(wrong),/binding|identity/i);
 const pending=setup();pending.members[2].binding.threadId='pending:x';pending.rounds[0].members[2].binding.threadId='pending:x';assert.throws(()=>plan(pending),/Pending/);
});
test('observed work or competing assignments prevent claiming non-delivery retry',()=>{
 let s=checked();s=evolve(s,{id:'observe',type:'observe',actor:'w',at:at(4),source,roundId:'r',taskId:'t1',observedAt:at(4),summary:'Doing work',progress:true},s.version);
 assert.equal(plan(s).decision,'supervise');assert.throws(()=>event(s,'deliveryClaim',{attemptId:'assign',summary:'retry'},5),/work|observ/i);
 const overlap=checked();overlap.tasks.push({...structuredClone(overlap.tasks[0]),id:'legacy-other'});assert.equal(plan(overlap).decision,'held');assert.throws(()=>event(overlap,'deliveryClaim',{attemptId:'assign',summary:'retry'},5),/reservation|busy|overlap/i);
 const advanced=setup();const submitted=evolve(advanced,{id:'submit',type:'submit',actor:'w',at:at(3),source,roundId:'r',taskId:'t1',summary:'done'},advanced.version);assert.equal(plan(submitted).decision,'supervise');assert.throws(()=>event(submitted,'deliveryCheck',checkData(),4),/executing|work/i);
});
test('invalid imported delivery chains and altered audit references fail closed',()=>{
 const s=event(checked(),'deliveryClaim',{attemptId:'assign',summary:'retry'},4);
 for(const mutate of [x=>x.events.at(-1).attemptId='wrong',x=>x.events[2].outcome='delivered',x=>x.events[2].actor='w',x=>delete x.events[2].summary,x=>x.events[2].outcome='failed']){const bad=structuredClone(s);mutate(bad);assert.throws(()=>validate(bad));}
});
test('legacy observations before delivery recovery invalidate the chain, later work remains valid',()=>{
 const s=event(checked(),'deliveryClaim',{attemptId:'assign',summary:'retry'},4);
 const legacy=n=>({id:'legacy',at:at(n),observedAt:at(n),summary:'Observed work',progress:false,source});
 for(const n of [2,3,4]){const bad=structuredClone(s);bad.tasks[0].observations.push(legacy(n));assert.throws(()=>validate(bad),/observ|work/i);}
 const later=event(s,'deliveryCheck',checkData('unknown','e3'),5);later.tasks[0].observations.push(legacy(5));assert.doesNotThrow(()=>validate(later));
 const sameTime=evolve(s,{id:'observe-later',type:'observe',actor:'w',at:at(4),source,roundId:'r',taskId:'t1',observedAt:at(4),summary:'Started after claim',progress:true},s.version);assert.doesNotThrow(()=>validate(sameTime));
});
test('blocked then resumed execution is supervised, not planned for initial delivery retry',()=>{
 let s=checked();for(const [type,n] of [['block',4],['unblock',5]])s=evolve(s,{id:type,type,actor:'m',at:at(n),source,roundId:'r',taskId:'t1',summary:'Decision changed'},s.version);
 assert.equal(s.tasks[0].status,'executing');assert.equal(plan(s).decision,'supervise');
 assert.throws(()=>event(s,'deliveryClaim',{attemptId:'assign',summary:'retry'},6),/initial executing/i);
});
test('delivery CLI writes only local records, validates versions and preserves failed-write bytes',async t=>{
 assert.equal(typeof api.checkDelivery,'function');const {path,dir}=await fixture(t),req=join(dir,'request.json'),who=join(dir,'caller.json');
 const request={id:'checked',caller,source,at:at(3),roundId:'r',taskId:'t1',...checkData()};await writeFile(req,JSON.stringify(request));await writeFile(who,JSON.stringify(caller));let result;
 await run(['delivery-check',path,req,'2'],x=>result=x);assert.match(result,/no host/i);
 await run(['delivery-plan',path,who,'t1'],x=>result=JSON.parse(x));assert.equal(result.decision,'ready-to-claim');
 await writeFile(req,JSON.stringify({id:'claim',caller,source,at:at(4),roundId:'r',taskId:'t1',attemptId:'assign',summary:'authorized retry'}));await run(['delivery-claim',path,req,'3'],()=>{});
 const before=await readFile(path,'utf8');await assert.rejects(api.checkDelivery(path,{...request,id:'stale'},3),/version/i);assert.equal(await readFile(path,'utf8'),before);
 for(const command of ['delivery-check','delivery-claim'])await assert.rejects(run([command,'missing','missing','9007199254740992']),/expectedVersion/);
});
test('concurrent recovery claims reserve only one attempt and survive restart',async t=>{
 assert.equal(typeof api.claimDelivery,'function');const {path}=await fixture(t,checked());const request={id:'claim',caller,source,at:at(4),roundId:'r',taskId:'t1',attemptId:'assign',summary:'retry'};
 const results=await Promise.allSettled([api.claimDelivery(path,request,3),api.claimDelivery(path,{...request,id:'other'},3)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const s=await readState(path);assert.equal(s.version,4);assert.equal(plan(s).decision,'reconcile');assert.equal(plan(s).delivery.attempts,1);
});
