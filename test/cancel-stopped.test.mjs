import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createState,evolve,validate,snapshot} from '../src/runtime.mjs';
import {initialize,readState,transact} from '../src/store.mjs';
import {planDispatch} from '../src/scheduling.mjs';
import {run} from '../src/cli.mjs';
import {render} from '../src/render.mjs';
const at=n=>new Date(Date.UTC(2026,8,15,0,n)).toISOString();
const caller={hostId:'fixture',threadId:'manager'},worker={hostId:'fixture',threadId:'worker'};
const source={kind:'fixture',ref:'synthetic-user-withdrawal'};
function setup(){
 let s=createState({teamId:'t',name:'Team',source,members:[['m','Manager','manager'],['l','Liaison','liaison'],['w','Worker','worker']].map(([id,role,threadId])=>({id,name:role,role,lifecycle:'active',binding:{status:'bound',hostId:'fixture',threadId}}))},at(0));
 const add=(type,data,n)=>s=evolve(s,{id:`e${s.version}`,actor:'m',type,at:at(n),source,...data},s.version);
 add('openRound',{roundId:'r',title:'Round'},1);
 add('assign',{roundId:'r',taskId:'task',title:'Work',workerId:'w',required:true,assignedAt:at(2)},2);
 add('deliveryCheck',{caller,roundId:'r',taskId:'task',attemptId:'e1',outcome:'delivered',summary:'Delivery verified'},3);
 add('observe',{actor:'w',roundId:'r',taskId:'task',observedAt:at(5),progress:false,summary:'Stopped; WIP retained',source:{kind:'host-observation',ref:'synthetic-stop',...worker}},5);
 return s;
}
function request(){return {id:'withdraw',type:'cancelStopped',actor:'m',caller,at:at(7),source,roundId:'r',taskId:'task',summary:'User withdrew requirement',cancellation:{
 worker:{...worker},authorizationRef:source.ref,authorizedAt:at(4),stopObservationId:'e3',workerAcknowledgementRef:'synthetic-worker-ack',
 idle:{status:'idle',checkedAt:at(6),ref:'synthetic-native-idle'},execution:{status:'stopped',checkedAt:at(6),inFlightMessages:'none',ref:'synthetic-process-check'},
 deliveryAttemptId:'e1',wip:{disposition:'retained',ref:'synthetic-wip-inventory',summary:'Two unfinished tests retained; no deletion'},
}};}
test('stopped cancellation preserves observations, delivery, audit and elapsed time; releases reservation only',()=>{
 const before=setup(),s=evolve(before,request(),before.version),t=s.tasks[0];
 assert.equal(t.status,'cancelled');assert.equal(t.acceptance,null);assert.equal(t.submissions,0);
 assert.deepEqual(t.observations,before.tasks[0].observations);assert.deepEqual(s.events.slice(0,-1),before.events);
 assert.deepEqual(s.events.at(-1).cancellation,request().cancellation);assert.deepEqual(s.events.at(-1).caller,caller);
 assert.equal(planDispatch(s,caller,'w').decision,'no-work');assert.deepEqual(s.reporting,before.reporting);
 assert.equal(s.rounds[0].status,'open');assert.equal(snapshot(s,at(60)).tasks[0].elapsedMs,5*60000);
 assert.equal(snapshot(s,at(60)).tasks[0].delivery.status,'delivered');
 assert.throws(()=>evolve(s,{...request(),id:'again',at:at(8)},s.version),/immutable/);
});
test('invalid evidence is rejected without mutation',()=>{
 const changes=[
 e=>e.actor='w',e=>e.caller=worker,e=>e.cancellation.worker.threadId='other',
 e=>delete e.cancellation.authorizationRef,e=>e.cancellation.authorizedAt=at(8),
 e=>e.cancellation.stopObservationId='missing',e=>delete e.cancellation.workerAcknowledgementRef,
 e=>e.cancellation.idle.status='running',e=>e.cancellation.idle.checkedAt=at(1),
 e=>e.cancellation.idle.checkedAt=at(8),e=>e.cancellation.execution.status='unknown',
 e=>e.cancellation.execution.inFlightMessages='unknown',e=>e.cancellation.execution.checkedAt=at(1),
 e=>e.cancellation.deliveryAttemptId='other',e=>e.cancellation.wip.disposition='discard',
 e=>delete e.cancellation.wip.ref,e=>e.cancellation.wip.summary='',e=>e.cancellation.extra=true,
 ];
 for(const change of changes){const s=setup(),old=JSON.stringify(s),e=request();change(e);assert.throws(()=>evolve(s,e,s.version));assert.equal(JSON.stringify(s),old);}
 const s=setup();assert.throws(()=>evolve(s,{...request(),at:at(12)},s.version),/idle/i);
});
test('Dashboard does not describe cancelled started work as never executed',()=>{
 const s=evolve(setup(),request(),4),html=render(snapshot(s,at(60)));
 assert.match(html,/User withdrew requirement/);assert.match(html,/已停止 · 未验收/);
 assert.doesNotMatch(html,/未执行|取消原因未知/);
});
test('unknown delivery, progress observation, changed binding and submitted work remain reserved',()=>{
 for(const variant of ['unknown','progress','binding','submitted','blocked']){
  let s=setup();
  if(variant==='unknown')s.events.find(e=>e.type==='deliveryCheck').outcome='unknown';
  if(variant==='progress')s.tasks[0].observations[0].progress=true;
  if(variant==='binding')s.members.find(m=>m.id==='w').binding.threadId='changed';
  if(['submitted','blocked'].includes(variant))s=evolve(s,{id:'advanced',type:variant==='submitted'?'submit':'block',actor:variant==='submitted'?'w':'m',source,at:at(6),roundId:'r',taskId:'task',summary:'advanced'},s.version);
  assert.throws(()=>evolve(s,request(),s.version));
 }
});
test('tampered cancellation audit fails validation',()=>{
 const s=evolve(setup(),request(),4);
 for(const change of [x=>delete x.events.at(-1).cancellation,x=>x.events.at(-1).caller=worker,x=>x.events.at(-1).cancellation.stopObservationId='absent',x=>x.events.at(-1).cancellation.idle.status='running']){
  const bad=structuredClone(s);change(bad);assert.throws(()=>validate(bad));
 }
});
test('stop observation audit must precede cancellation even at equal timestamps',()=>{
 const event=request();event.at=at(5);event.cancellation.idle.checkedAt=at(5);event.cancellation.execution.checkedAt=at(5);
 const s=evolve(setup(),event,4),bad=structuredClone(s);
 [bad.events[3],bad.events[4]]=[bad.events[4],bad.events[3]];
 assert.throws(()=>validate(bad),/precede/);
 const missing=structuredClone(s);missing.events[3].type='block';assert.throws(()=>validate(missing),/observation audit/);
});
test('CLI shares CAS and lock; failed cancellation preserves bytes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cancel-stopped-')),path=join(dir,'state.json'),req=join(dir,'request.json');
 await initialize(path,setup());const {type,actor,...payload}=request();await writeFile(req,JSON.stringify(payload));
 const before=await readFile(path,'utf8');await assert.rejects(run(['cancel-stopped',path,req,'3']));assert.equal(await readFile(path,'utf8'),before);
 let out;await run(['cancel-stopped',path,req,'4'],s=>out=s);assert.match(out,/no host/);
 assert.equal((await readState(path)).tasks[0].status,'cancelled');const after=await readFile(path,'utf8');
 await assert.rejects(run(['cancel-stopped',path,req,'5']));assert.equal(await readFile(path,'utf8'),after);
});
test('concurrent submission versus cancellation admits exactly one writer',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cancel-stopped-race-')),path=join(dir,'state.json');await initialize(path,setup());
 const submit={id:'submit',type:'submit',actor:'w',source,at:at(7),roundId:'r',taskId:'task',summary:'new submission'};
 const outcomes=await Promise.allSettled([transact(path,4,request()),transact(path,4,submit)]);
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 const s=await readState(path);assert.equal(s.version,5);assert.ok(['cancelled','submitted'].includes(s.tasks[0].status));
});
test('cancellation keeps FIFO, does not send work and round closure is separate',()=>{
 let s=setup();s=evolve(s,{id:'queued',type:'enqueue',actor:'m',caller,source,at:at(6),roundId:'r',taskId:'next',title:'Next',workerId:'w',required:true,assignedAt:null},4);
 const queued=structuredClone(s.tasks[1]);s=evolve(s,request(),5);
 const plan=planDispatch(s,caller,'w');assert.equal(plan.decision,'ready');assert.equal(plan.nextTaskId,'next');assert.equal(plan.hostRequest,null);assert.deepEqual(s.tasks[1],queued);
 let closed=evolve(setup(),request(),4);closed=evolve(closed,{id:'close',type:'closeRound',actor:'m',source,at:at(8),roundId:'r'},5);
 assert.equal(closed.rounds[0].status,'closed');assert.equal(closed.tasks.filter(t=>t.status==='approved').length,0);
});
test('linked readiness and prepared fence remain enforced',()=>{
 const s=setup();s.schemaVersion=2;s.registry={registryId:'reg',registryPath:join(tmpdir(),'fixture-registry.json'),teamId:'t',migrationId:'migration',sourceSha256:'a'.repeat(64),sourceVersion:4,phase:'active',teamRevision:1,readyMemberIds:['m','l','w']};
 assert.equal(evolve(s,request(),4).tasks[0].status,'cancelled');
 for(const ids of [['l','w'],['m','l']]){const bad=structuredClone(s);bad.registry.readyMemberIds=ids;assert.throws(()=>evolve(bad,request(),4),/ready/);}
 const prepared=structuredClone(s);prepared.registry.phase='prepared';prepared.registry.teamRevision=0;prepared.registry.readyMemberIds=[];assert.throws(()=>evolve(prepared,request(),4),/prepared/);
});
