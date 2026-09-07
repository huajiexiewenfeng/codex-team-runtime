import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createState,evolve,validate,snapshot} from '../src/runtime.mjs';
import {initialize,readState} from '../src/store.mjs';
import * as scheduling from '../src/scheduling.mjs';
import {planSupervision} from '../src/supervision.mjs';
import {render} from '../src/render.mjs';
import {run} from '../src/cli.mjs';
const at=n=>new Date(Date.UTC(2026,8,7,0,n)).toISOString();
const caller={hostId:'fixture',threadId:'manager'},source={kind:'fixture',ref:'explicit-user-withdrawal'};
function event(s,type,data={},n=1){return evolve(s,{id:`e${s.version}`,actor:'m',caller,source,at:at(n),type,...data},s.version);}
function setup(){let s=createState({teamId:'t',name:'Team',source,members:[['m','Manager','manager'],['l','Liaison','liaison'],['w','Worker','worker']].map(([id,role,threadId])=>({id,name:role,role,lifecycle:'active',binding:{status:'bound',hostId:'fixture',threadId}}))},at(0));s=evolve(s,{id:'open',actor:'m',source,at:at(1),type:'openRound',roundId:'r',title:'Round'},0);return event(s,'enqueue',{roundId:'r',taskId:'q1',title:'Queued 1',workerId:'w',required:true,assignedAt:null},2);}
const cancel=(taskId='q1')=>({roundId:'r',taskId,summary:'User withdrew this requirement'});
function cancelled(){return event(setup(),'cancelQueued',cancel(),5);}
async function fixture(t,s=setup()){const dir=await mkdtemp(join(tmpdir(),'cancel-queue-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'state.json');await initialize(path,s);return {dir,path};}
test('cancellation preserves history, freezes waiting time and is not approval',()=>{
 const before=setup(),s=event(before,'cancelQueued',cancel(),5),task=s.tasks[0];
 assert.deepEqual(s.events.slice(0,-1),before.events);assert.equal(before.tasks[0].status,'queued');
 assert.equal(task.status,'cancelled');assert.equal(task.assignedAt,null);assert.equal(task.completedAt,at(5));assert.equal(task.acceptance,null);assert.equal(task.submissions,0);
 assert.equal(s.events.at(-1).summary,cancel().summary);assert.equal(s.events.at(-1).actor,'m');assert.deepEqual(s.reporting,before.reporting);
 for(const n of [6,60]){const view=snapshot(s,at(n)).tasks[0];assert.equal(view.elapsedMs,null);assert.equal(view.phaseElapsedMs,0);assert.equal(view.stages[0].durationMs,3*60000);}
});
test('cancelled queue head does not reserve Worker or jump remaining FIFO',()=>{
 let s=setup();s=event(s,'enqueue',{roundId:'r',taskId:'q2',title:'Next',workerId:'w',required:true,assignedAt:null},3);s=event(s,'cancelQueued',cancel(),5);
 const plan=scheduling.planDispatch(s,caller,'w');assert.equal(plan.decision,'ready');assert.deepEqual(plan.queuedTaskIds,['q2']);assert.deepEqual(plan.reservedTaskIds,[]);assert.equal(plan.hostRequest,null);
 assert.deepEqual(planSupervision(s,caller).batches,[]);s=event(s,'startTask',{roundId:'r',taskId:'q2'},6);assert.equal(s.tasks[1].status,'executing');
});
test('cancellation cannot stop an executing or previously submitted task',()=>{
 let active=event(setup(),'startTask',{roundId:'r',taskId:'q1'},3);
 for(const status of ['executing','submitted','reviewing','rework','blocked','approved']){
  let s=structuredClone(active);const raw=(type,data={},actor='m')=>{s=evolve(s,{id:`x${s.version}`,type,actor,at:at(4),source,roundId:'r',taskId:'q1',...data},s.version);};
  if(['submitted','reviewing','rework','approved'].includes(status))raw('submit',{summary:'ready'},'w');
  if(['reviewing','rework','approved'].includes(status))raw('review');
  if(status==='rework')raw('rework',{summary:'fix'});if(status==='blocked')raw('block',{summary:'blocked'});if(status==='approved')raw('approve',{summary:'verified',evidence:['fixture']});
  const before=JSON.stringify(s);assert.throws(()=>event(s,'cancelQueued',cancel(),5),/queued|immutable/i);assert.equal(JSON.stringify(s),before);
 }
});
test('cancelling pending T2 preserves executing T1 and queued T3',()=>{
 let s=event(setup(),'startTask',{roundId:'r',taskId:'q1'},3);
 for(const id of ['q2','q3'])s=event(s,'enqueue',{roundId:'r',taskId:id,title:id,workerId:'w',required:true,assignedAt:null},4);
 const active=structuredClone(s.tasks[0]),third=structuredClone(s.tasks[2]);
 s=event(s,'cancelQueued',cancel('q2'),5);assert.deepEqual(s.tasks[0],active);assert.deepEqual(s.tasks[2],third);
 const plan=scheduling.planDispatch(s,caller,'w');assert.equal(plan.decision,'held');assert.deepEqual(plan.reservedTaskIds,['q1']);assert.deepEqual(plan.queuedTaskIds,['q3']);
 assert.throws(()=>evolve(s,{id:'close',type:'closeRound',actor:'m',source,at:at(6),roundId:'r'},s.version),/Unaccepted/);
});
test('cancelled records are terminal and require matching cancellation audit',()=>{
 const s=cancelled();
 for(const change of [{type:'cancelQueued',caller,summary:'again'},{type:'startTask',caller},{type:'observe',summary:'note',progress:true,observedAt:at(6)},{type:'block',summary:'blocked'},{type:'approve',summary:'accepted',evidence:['fixture']},{type:'submit',actor:'w',summary:'ready'},{type:'review'},{type:'rework',summary:'again'},{type:'unblock',summary:'clear'}])
  assert.throws(()=>evolve(s,{id:'terminal',actor:'m',at:at(6),source,roundId:'r',taskId:'q1',...change},s.version),/Cancelled task immutable/);
 for(const mutate of [x=>delete x.events.at(-1).summary,x=>x.events.at(-1).actor='w',x=>x.events.at(-1).type='review',x=>x.tasks[0].completedAt=at(4),x=>x.tasks[0].acceptance={actor:'m'}]){const bad=structuredClone(s);mutate(bad);assert.throws(()=>validate(bad));}
});
test('all-cancelled round can close without claiming accepted delivery or auto-closing',()=>{
 let s=cancelled();assert.equal(s.rounds[0].status,'open');s=evolve(s,{id:'close',type:'closeRound',actor:'m',source,at:at(6),roundId:'r'},s.version);
 assert.equal(s.rounds[0].status,'closed');assert.equal(s.tasks.filter(t=>t.status==='approved').length,0);assert.equal(s.reporting.desired,'stopped');assert.equal(s.reporting.actual,'unknown');
 const html=render(snapshot(s,at(10)));assert.match(html,/已取消/);assert.doesNotMatch(html,/已关闭轮次的交付已验收/);
});
test('cancel CLI requires exact caller/reason/version and preserves bytes on rejection',async t=>{
 assert.equal(typeof scheduling.cancelQueuedTask,'function');const {dir,path}=await fixture(t),req=join(dir,'cancel.json');const request={id:'cancel',caller,at:at(5),source,...cancel()};
 const before=await readFile(path,'utf8');
 for(const bad of [{...request,caller:{hostId:'fixture',threadId:'liaison'}},{...request,summary:''},{...request,caller:undefined},{...request,unexpected:true}])await assert.rejects(scheduling.cancelQueuedTask(path,bad,2));
 await assert.rejects(scheduling.cancelQueuedTask(path,request,1),/version/i);assert.equal(await readFile(path,'utf8'),before);
 await writeFile(req,JSON.stringify(request));let output;await run(['cancel-queued',path,req,'2'],v=>output=v);assert.match(output,/no host/i);assert.equal((await readState(path)).tasks[0].status,'cancelled');
 const after=await readFile(path,'utf8');await assert.rejects(scheduling.cancelQueuedTask(path,{...request,id:'repeat'},3));assert.equal(await readFile(path,'utf8'),after);
 await assert.rejects(run(['cancel-queued','missing','missing','9007199254740992']),/expectedVersion/);
});
test('start versus cancel CAS admits only one terminal decision',async t=>{
 assert.equal(typeof scheduling.cancelQueuedTask,'function');const {path}=await fixture(t);const base={caller,source,at:at(5),roundId:'r',taskId:'q1'};
 const results=await Promise.allSettled([scheduling.startTask(path,{...base,id:'start'},2),scheduling.cancelQueuedTask(path,{...base,id:'cancel',summary:'Withdrawn'},2)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const s=await readState(path);assert.equal(s.version,3);assert.ok(['executing','cancelled'].includes(s.tasks[0].status));
});
