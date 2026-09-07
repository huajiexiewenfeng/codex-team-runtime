import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState, evolve, validate, snapshot } from '../src/runtime.mjs';
import { initialize, transact, readState } from '../src/store.mjs';
const at=n=>new Date(Date.UTC(2026,8,7,0,n)).toISOString();
const source={kind:'fixture',ref:'scheduling-test'},caller={hostId:'fixture-host',threadId:'fixture-m'};
function setup(){let s=createState({teamId:'team',name:'Team',source,members:[['m','Manager'],['l','Liaison'],['w','Worker'],['w2','Worker']].map(([id,role])=>({id,role,name:id,lifecycle:'active',binding:{status:'bound',hostId:'fixture-host',threadId:`fixture-${id}`}}))},at(0));return event(s,'openRound',{roundId:'r',title:'R'});}
function event(s,type,data={},n=1,actor='m'){return evolve(s,{id:`e${s.version}`,type,actor,at:at(n),source,...(['enqueue','startTask'].includes(type)?{caller}:{}),...data},s.version);}
const data=(taskId,roundId='r',workerId='w')=>({roundId,taskId,title:taskId,workerId,required:true,assignedAt:null});
function finish(s,taskId='a',roundId='r',n=5){s=event(s,'submit',{roundId,taskId,summary:'submitted'},n,'w');s=event(s,'review',{roundId,taskId},n);return event(s,'approve',{roundId,taskId,summary:'checked',evidence:['fixture:test']},n);}
test('busy Worker admission is rejected across rounds until approval, other Workers remain independent',()=>{
 let s=event(setup(),'assign',data('a'));s=event(s,'openRound',{roundId:'r2',title:'R2'});
 for(const stage of ['executing','submitted','reviewing','rework','blocked']){
  let x=structuredClone(s);
  if(['submitted','reviewing','rework'].includes(stage))x=event(x,'submit',{roundId:'r',taskId:'a',summary:'x'},2,'w');
  if(['reviewing','rework'].includes(stage))x=event(x,'review',{roundId:'r',taskId:'a'},2);
  if(stage==='rework')x=event(x,'rework',{roundId:'r',taskId:'a',summary:'x'},2);
  if(stage==='blocked')x=event(x,'block',{roundId:'r',taskId:'a',summary:'x'},2);
  assert.throws(()=>event(x,'assign',data('b','r2'),3),/busy/i);
  assert.doesNotThrow(()=>event(x,'assign',data('b','r2','w2'),3));
 }
 s=finish(s);assert.doesNotThrow(()=>event(s,'assign',data('b','r2'),6));
});
test('enqueue stays nonexecuting with queue phase time and cannot perform task work',()=>{
 const s=event(setup(),'enqueue',data('q'),2);const t=snapshot(s,at(8)).tasks[0];
 assert.equal(t.status,'queued');assert.equal(t.assignedAt,null);assert.equal(t.elapsedMs,null);assert.equal(t.phaseElapsedMs,360000);
 for(const type of ['submit','review','block','observe'])assert.throws(()=>event(s,type,{roundId:'r',taskId:'q',...(type==='submit'||type==='block'?{summary:'x'}:{}),...(type==='observe'?{summary:'x',progress:true,observedAt:at(2)}:{})},3,type==='submit'?'w':'m'));
 assert.throws(()=>event(s,'closeRound',{roundId:'r'},3));
});
test('startTask obeys insertion FIFO across rounds and direct assignment cannot jump queue',()=>{
 let s=setup();s=event(s,'openRound',{roundId:'r2',title:'R2'});s=event(s,'enqueue',data('q1','r2'),2);s=event(s,'enqueue',data('q2'),2);
 assert.throws(()=>event(s,'assign',data('jump'),3),/queue/i);
 assert.throws(()=>event(s,'startTask',{roundId:'r',taskId:'q2'},3),/FIFO|head/i);
 s=event(s,'startTask',{roundId:'r2',taskId:'q1',caller},4);
 assert.equal(s.tasks[0].assignedAt,at(4));assert.equal(snapshot(s,at(7)).tasks[0].elapsedMs,180000);assert.equal(s.tasks[0].stages[0].endedAt,at(4));
 assert.throws(()=>event(s,'startTask',{roundId:'r',taskId:'q2'},5),/busy/i);
 s=finish(s,'q1','r2',6);s=event(s,'startTask',{roundId:'r',taskId:'q2'},7);assert.equal(s.tasks[1].status,'executing');
});
test('new scheduling caller declarations fail closed and input state remains unchanged',()=>{
 let s=setup();const before=JSON.stringify(s);
 assert.throws(()=>event(s,'enqueue',{...data('q'),caller:{...caller,threadId:'wrong'}},2));
 assert.throws(()=>event(s,'enqueue',data('q'),2,'w'));assert.equal(JSON.stringify(s),before);
 s=event(s,'enqueue',{...data('q'),caller},2);
 for(const bad of [{...caller,hostId:'wrong'},{...caller,verified:true},null])assert.throws(()=>event(s,'startTask',{roundId:'r',taskId:'q',caller:bad},3));
 const changed=structuredClone(s);changed.members.find(m=>m.id==='w').binding.threadId='changed';assert.throws(()=>event(changed,'startTask',{roundId:'r',taskId:'q'},3));
});
test('queue import enforces timing and observations while legacy multiple-active state remains readable',()=>{
 const s=event(setup(),'enqueue',data('q'),2);const bad=structuredClone(s);bad.tasks[0].assignedAt=at(2);assert.throws(()=>validate(bad));
 const observed=structuredClone(s);observed.tasks[0].observations.push({id:'o',at:at(2),observedAt:at(2),summary:'x',progress:true,source});assert.throws(()=>validate(observed));
 let old=event(setup(),'assign',data('a'));old.tasks.push({...structuredClone(old.tasks[0]),id:'legacy-second'});assert.equal(validate(old),old);assert.throws(()=>event(old,'assign',data('new'),2),/busy/i);
});
test('enqueue requires null assignedAt; started queued task timing freezes only execution elapsed',()=>{
 assert.throws(()=>event(setup(),'enqueue',{...data('q'),assignedAt:at(1)},2));
 let s=event(setup(),'enqueue',data('q'),2);s=event(s,'startTask',{roundId:'r',taskId:'q'},4);s=finish(s,'q','r',7);
 const v=snapshot(s,at(20)).tasks[0];assert.equal(v.elapsedMs,180000);assert.equal(v.stages[0].durationMs,120000);
 const bad=structuredClone(s);bad.tasks[0].assignedAt=at(2);assert.throws(()=>validate(bad));
});
test('new scheduling requires caller while legacy direct assign remains compatible',()=>{
 const s=setup(),queued=event(s,'enqueue',data('q'),2);
 for(const [state,type,details] of [[s,'enqueue',data('q')],[queued,'startTask',{roundId:'r',taskId:'q'}]]){
  const before=structuredClone(state);
  assert.throws(()=>evolve(state,{id:'missing-caller',type,actor:'m',at:at(3),source,...details},state.version));
  assert.deepEqual(state,before);
 }
 assert.doesNotThrow(()=>event(s,'assign',data('legacy')));
});

test('admission rejects legacy pending Worker identifiers without changing input',()=>{
 for(const threadId of ['pending:worker','client-new-thread:worker'])for(const type of ['assign','enqueue','startTask']){
  let s=setup();if(type==='startTask')s=event(s,'enqueue',data('q'),2);
  s.members.find(m=>m.id==='w').binding.threadId=threadId;
  s.rounds[0].members.find(m=>m.id==='w').binding.threadId=threadId;
  assert.equal(validate(s),s);const before=structuredClone(s);
  assert.throws(()=>event(s,type,type==='startTask'?{roundId:'r',taskId:'q'}:data('q'),3),/pending/i);
  assert.deepEqual(s,before);
 }
});

test('concurrent starts admit only one Worker reservation under the state lock',async t=>{
 let s=event(setup(),'enqueue',data('q'),2);const dir=await mkdtemp(join(tmpdir(),'scheduling-test-')),path=join(dir,'state.json');t.after(()=>rm(dir,{recursive:true,force:true}));await initialize(path,s);
 const e={id:'start',type:'startTask',actor:'m',at:at(3),source,roundId:'r',taskId:'q',caller};
 const results=await Promise.allSettled([transact(path,s.version,e),transact(path,s.version,{...e,id:'other'})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const next=await readState(path);assert.equal(next.version,s.version+1);
 const before=await readFile(path,'utf8');await assert.rejects(transact(path,next.version,{id:'jump',type:'assign',actor:'m',at:at(4),source,...data('new')}),/busy/i);assert.equal(await readFile(path,'utf8'),before);
});
