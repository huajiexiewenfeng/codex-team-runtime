import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState, evolve } from '../src/runtime.mjs';
import { initialize, readState } from '../src/store.mjs';
import { run } from '../src/cli.mjs';
import { planSupervision } from '../src/supervision.mjs';
import { snapshot } from '../src/runtime.mjs';
import { render } from '../src/render.mjs';
import { resume } from '../src/session.mjs';
const api=await import('../src/scheduling.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {};});
const caller={hostId:'fixture',threadId:'manager'},source={kind:'fixture',ref:'scheduling-tests'},at='2026-09-07T00:00:00.000Z';
function state(){let s=createState({teamId:'team',name:'Team',source,members:[['m','Manager','manager'],['l','Liaison','liaison'],['w','Worker','worker']].map(([id,role,threadId])=>({id,name:role,role,lifecycle:'active',binding:{status:'bound',hostId:'fixture',threadId}}))},at);return evolve(s,{id:'open',type:'openRound',actor:'m',at,source,roundId:'r',title:'Round'},s.version);}
const request=(id='t1')=>({id:`enqueue-${id}`,caller,at,source,roundId:'r',taskId:id,title:id,workerId:'w',required:true});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'team-queue-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'state.json');await initialize(path,state());return {dir,path};}
test('durable queue and readonly plan do not start work or supervise queue-only Workers',async t=>{
 assert.equal(typeof api.queueTask,'function');const {path}=await fixture(t);let s=await api.queueTask(path,request(),1);
 assert.equal(s.tasks[0].status,'queued');assert.equal(s.tasks[0].assignedAt,null);const before=await readFile(path,'utf8');
 const plan=api.planDispatch(s,caller,'w');assert.equal(plan.decision,'ready');assert.equal(plan.nextTaskId,'t1');assert.equal(plan.hostRequest,null);assert.equal(plan.executed,false);
 assert.deepEqual(planSupervision(s,caller).batches,[]);assert.equal(await readFile(path,'utf8'),before);
 assert.match(render(snapshot(s,at)),/排队中/);
 assert.match((await resume(path,caller,at)).nextActions.join(' '),/queue/i);
 assert.match((await resume(path,{hostId:'fixture',threadId:'worker'},at)).nextActions.join(' '),/queued/i);
});
test('busy holds FIFO and stale/unauthorized requests preserve state',async t=>{
 assert.equal(typeof api.startTask,'function');const {path}=await fixture(t);let s=await api.queueTask(path,request(),1);s=await api.queueTask(path,request('t2'),s.version);
 const start={id:'start-t1',caller,at,source,roundId:'r',taskId:'t1'};
 await assert.rejects(api.startTask(path,{...start,taskId:'t2'},s.version),/queue|FIFO|first/i);
 s=await api.startTask(path,start,s.version);assert.equal(s.tasks[0].status,'executing');assert.equal(api.planDispatch(s,caller,'w').decision,'held');const before=await readFile(path,'utf8');
 await assert.rejects(api.startTask(path,{...start,id:'start-t2',taskId:'t2'},s.version),/busy|reserv|outstanding/i);
 await assert.rejects(api.queueTask(path,request('t3'),s.version-1),/version/i);
 await assert.rejects(api.queueTask(path,{...request('t3'),caller:{hostId:'fixture',threadId:'worker'}},s.version),/Manager/i);
 await assert.rejects(api.queueTask(path,{...request('t3'),surprise:true},s.version),/field/i);
 assert.throws(()=>api.planDispatch(s,{hostId:'fixture',threadId:'liaison'},'w'),/Manager/i);
 const changed=structuredClone(s);changed.members.find(m=>m.id==='w').binding.threadId='different';assert.throws(()=>api.planDispatch(changed,caller,'w'),/identity|binding/i);
 assert.equal(await readFile(path,'utf8'),before);
});
test('competing starts reserve once',async t=>{
 assert.equal(typeof api.startTask,'function');const {path}=await fixture(t);let s=await api.queueTask(path,request(),1);const start={id:'start-t1',caller,at,source,roundId:'r',taskId:'t1'};
 const results=await Promise.allSettled([api.startTask(path,start,s.version),api.startTask(path,{...start,id:'competing'},s.version)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await readState(path)).version,3);
});
test('CLI uses explicit queue/start requests and rejects unsafe versions before I/O',async t=>{
 const {dir,path}=await fixture(t),req=join(dir,'request.json'),who=join(dir,'caller.json'),output=[];
 await writeFile(req,JSON.stringify(request()));await writeFile(who,JSON.stringify(caller));
 await run(['queue-task',path,req,'1'],s=>output.push(s));await run(['dispatch-plan',path,who,'w'],s=>output.push(s));assert.equal(JSON.parse(output[1]).nextTaskId,'t1');
 await writeFile(req,JSON.stringify({id:'start-t1',caller,at,source,roundId:'r',taskId:'t1'}));await run(['start-task',path,req,'2'],s=>output.push(s));assert.equal((await readState(path)).tasks[0].status,'executing');
 for(const command of ['queue-task','start-task'])await assert.rejects(run([command,'missing','missing','9007199254740992']),/expectedVersion/);
});
