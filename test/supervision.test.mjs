import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, evolve, validate } from '../src/runtime.mjs';

// Import dynamically so the first red run reports a missing public capability.
const module = await import('../src/supervision.mjs').catch(error => {
 if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;
 return {};
});
const manager={hostId:'fixture-host',threadId:'fixture-manager'};
const source={kind:'fixture',ref:'supervision-tests'};
const at='2026-09-05T00:00:00.000Z';
function stateWith(count=1) {
 const members=[{id:'m',name:'Manager',role:'Manager',lifecycle:'active',binding:{status:'bound',...manager}},
  {id:'l',name:'Liaison',role:'Liaison',lifecycle:'active',binding:{status:'bound',hostId:'fixture-host',threadId:'fixture-liaison'}},
  ...Array.from({length:count},(_,i)=>({id:`w${i}`,name:`Worker ${i}`,role:'Worker',lifecycle:'active',binding:{status:'bound',hostId:'fixture-host',threadId:`fixture-worker-${i}`}}))];
 let s=createState({teamId:'fixture-team',name:'Fixture',source,members},at);
 s=evolve(s,{id:'open',type:'openRound',actor:'m',at,source,roundId:'r1',title:'Round'},s.version);
 for(let i=0;i<count;i++)s=evolve(s,{id:`assign-${i}`,type:'assign',actor:'m',at,source,roundId:'r1',taskId:`t${i}`,title:`Task ${i}`,workerId:`w${i}`,required:true,assignedAt:at},s.version);
 return s;
}
function api() {assert.equal(typeof module.planSupervision,'function','planSupervision capability missing');assert.equal(typeof module.runSupervision,'function','runSupervision capability missing');return module;}
test('supervision retains durable review work when native observation fails and no notification arrived',async()=>{
 const {runSupervision}=api();let s=stateWith(3);
 for(const i of [0,1])s=evolve(s,{id:`submit-${i}`,type:'submit',actor:`w${i}`,at,source,roundId:'r1',taskId:`t${i}`,summary:`Evidence ${i}`},s.version);
 s=evolve(s,{id:'review-1',type:'review',actor:'m',at,source,roundId:'r1',taskId:'t1'},s.version);
 const before=structuredClone(s);
 const result=await runSupervision(s,manager,async()=>{throw new Error('native observation unavailable');});
 assert.equal(result.pendingSubmissions?.notices.length,1);
 assert.equal(result.pendingSubmissions.notices[0].taskId,'t0');
 assert.deepEqual(result.taskChecks?.map(x=>[x.taskId,x.taskStatus,x.nextAction]),[
  ['t0','submitted','inspect-submission'],['t1','reviewing','continue-review'],['t2','executing','check-progress']]);
 assert.ok(result.taskChecks.every(x=>x.notificationStatus==='unknown'));
 assert.equal(result.batchResults[0].status,'error');assert.deepEqual(s,before);
});
test('plans exact batches of at most eight with cursor identity and no execution',()=>{
 const {planSupervision}=api(),s=stateWith(10),before=structuredClone(s);
 const cursors=[{hostId:'fixture-host',threadId:'fixture-worker-8',afterCursor:'opaque-8'}];
 const plan=planSupervision(s,manager,cursors);
 assert.deepEqual(plan.batches.map(x=>x.targets.length),[8,2]);assert.ok(plan.batches.every(x=>x.timeoutMs===0));
 assert.deepEqual(plan.batches[1].targets[0],cursors[0]);assert.equal(plan.sourceVersion,s.version);assert.equal(plan.executed,false);assert.equal(plan.readOnly,true);assert.equal(plan.identityAssurance,'caller-declared');assert.deepEqual(s,before);
 assert.deepEqual(plan.team.source,source);assert.deepEqual(plan.sourceKinds,['fixture']);
});
test('blocked work remains actionable with empty native output and no fabricated submission',async()=>{
 const {runSupervision}=api();let s=stateWith();
 s=evolve(s,{id:'block',type:'block',actor:'m',at,source,roundId:'r1',taskId:'t0',summary:'Waiting for build input'},s.version);
 const before=structuredClone(s),result=await runSupervision(s,manager,async()=>({items:[]}));
 assert.equal(result.taskChecks[0].nextAction,'inspect-blocker');
 assert.equal(result.taskChecks[0].taskStatus,'blocked');
 assert.deepEqual(result.pendingSubmissions.notices,[]);
 assert.deepEqual(s,before);
});
test('deduplicates historical Worker across tasks and excludes accepted work',()=>{
 const {planSupervision}=api();let s=stateWith(2);
 // Legacy imports may overlap a Worker's tasks; new assign admission must not.
 s.tasks.push({...structuredClone(s.tasks.find(t=>t.id==='t0')),id:'extra',title:'More'});
 s.events.push({...structuredClone(s.events.find(e=>e.id==='assign-0')),id:'assign-more',taskId:'extra'});
 s.version++;validate(s);
 for(const [i,e] of [{type:'submit',actor:'w1',summary:'Submitted'},{type:'review',actor:'m'},{type:'approve',actor:'m',summary:'Accepted',evidence:['fixture']}].entries()) s=evolve(s,{id:`complete-${i}`,at,source,roundId:'r1',taskId:'t1',...e},s.version);
 assert.deepEqual(planSupervision(s,manager).batches,[{targets:[{hostId:'fixture-host',threadId:'fixture-worker-0'}],timeoutMs:0}]);
});
test('rejects non-Manager, unknown/pending caller and bad cursors before calls',async()=>{
 const {planSupervision,runSupervision}=api(),s=stateWith();let calls=0;const wait=async()=>{calls++;return {};};
 for(const caller of [{hostId:'fixture-host',threadId:'fixture-liaison'},{...manager,threadId:'unknown'},{...manager,threadId:'client-new-thread:123'},{...manager,verified:true}]) await assert.rejects(runSupervision(s,caller,wait));
 for(const cursors of [[{hostId:'wrong',threadId:'fixture-worker-0',afterCursor:'x'}],[{hostId:'fixture-host',threadId:'fixture-worker-0',afterCursor:''}],[{hostId:'fixture-host',threadId:'fixture-worker-0',afterCursor:'x'},{hostId:'fixture-host',threadId:'fixture-worker-0',afterCursor:'y'}]])assert.throws(()=>planSupervision(s,manager,cursors));
 assert.equal(calls,0);
});
test('no unfinished work makes zero tool calls and needs no injected adapter',async()=>{
 const {runSupervision}=api();let s=stateWith(0),calls=0;
 const r=await runSupervision(s,manager,async()=>{calls++;return {};});assert.equal(calls,0);assert.deepEqual(r.batchResults,[]);assert.equal(r.executed,false);
 assert.deepEqual(r.taskChecks,[]);assert.deepEqual(r.pendingSubmissions.notices,[]);
 assert.deepEqual((await runSupervision(s,manager)).batchResults,[]);
});
test('executes each batch once and preserves unknown raw results without business changes',async()=>{
 const {runSupervision}=api(),s=stateWith(9),before=structuredClone(s),calls=[];
 const raw={content:[{type:'text',text:'native unknown result; not business approval'}]};
 const result=await runSupervision(s,manager,async request=>{calls.push(structuredClone(request));return raw;});
 assert.equal(calls.length,2);assert.equal(result.executed,true);assert.ok(result.batchResults.every(b=>b.rawResult===raw&&b.requiresManagerReview===true&&b.status==='returned'));
 assert.ok(s.tasks.every(t=>t.status==='executing'));assert.deepEqual(s,before);
});
test('reports tool exceptions and missing results without retries or invented acceptance',async()=>{
 const {runSupervision}=api(),s=stateWith(9);let calls=0;
 const result=await runSupervision(s,manager,async()=>{calls++;if(calls===1)throw new Error('fixture host unavailable');return undefined;});
 assert.equal(calls,2);assert.deepEqual(result.batchResults.map(b=>b.status),['error','invalid-result']);assert.match(result.batchResults[0].error.message,/fixture host unavailable/);assert.ok(result.batchResults.every(b=>b.requiresManagerReview));assert.equal(s.tasks[0].status,'executing');
});
test('closed rounds, exited Manager and pending Worker do not produce host requests',async()=>{
 const {planSupervision,runSupervision}=api();let s=stateWith();
 for(const [i,e] of [{type:'submit',actor:'w0',summary:'Submitted'},{type:'review',actor:'m'},{type:'approve',actor:'m',summary:'Accepted',evidence:['fixture']}].entries())s=evolve(s,{id:`done-${i}`,at,source,roundId:'r1',taskId:'t0',...e},s.version);
 s=evolve(s,{id:'close',type:'closeRound',actor:'m',at,source,roundId:'r1'},s.version);
 assert.deepEqual(planSupervision(s,manager).batches,[]);
 s=evolve(s,{id:'exit',type:'exitMember',actor:'m',at,source,memberId:'m'},s.version);
 await assert.rejects(runSupervision(s,manager,()=>{throw new Error('Must not call');}),/Manager/);
 const pending=stateWith();pending.members.find(m=>m.id==='w0').binding.threadId='client-new-thread:123';pending.rounds[0].members.find(m=>m.id==='w0').binding.threadId='client-new-thread:123';
 const plan=planSupervision(pending,manager);assert.deepEqual(plan.batches,[]);assert.equal(plan.taskChecks[0].nextAction,'reconcile-identity');
});

test('one mismatched Worker cannot hide other submitted work or enter native targets',()=>{
 let s=stateWith(2);
 for(const i of [0,1])s=evolve(s,{id:`s-${i}`,type:'submit',actor:`w${i}`,at,source,roundId:'r1',taskId:`t${i}`,summary:'Evidence'},s.version);
 s.members.find(m=>m.id==='w0').binding.threadId='fixture-other';const before=structuredClone(s);
 const cursor={hostId:'fixture-host',threadId:'fixture-worker-0',afterCursor:'old-cursor'};
 const result=api().planSupervision(s,manager,[cursor]);
 assert.equal(result.taskChecks[0].nextAction,'reconcile-identity');assert.equal(result.taskChecks[0].worker,null);
 assert.deepEqual(result.pendingSubmissions.notices.map(n=>n.taskId),['t1']);
 assert.deepEqual(result.pendingSubmissions.blockedTaskIds,['t0']);
 assert.deepEqual(result.batches[0].targets,[{hostId:'fixture-host',threadId:'fixture-worker-1'}]);
 assert.deepEqual(result.recoverySummary,{pendingReview:1,reviewing:0,blocked:0,identityBlocked:1});
 assert.deepEqual(result.ignoredCursors,[{...cursor,reason:'identity-blocked'}]);
 assert.deepEqual(s,before);
});

test('recovery summary derives pending review, ongoing review and blockers without notification evidence',()=>{
 let s=stateWith(3);
 for(const i of [0,1])s=evolve(s,{id:`s-${i}`,type:'submit',actor:`w${i}`,at,source,roundId:'r1',taskId:`t${i}`,summary:'Evidence'},s.version);
 s=evolve(s,{id:'review',type:'review',actor:'m',at,source,roundId:'r1',taskId:'t1'},s.version);
 s=evolve(s,{id:'blocked',type:'block',actor:'m',at,source,roundId:'r1',taskId:'t2',summary:'Needs input'},s.version);
 const result=api().planSupervision(s,manager);
 assert.deepEqual(result.recoverySummary,{pendingReview:1,reviewing:1,blocked:1,identityBlocked:0});
 assert.ok(result.taskChecks.every(t=>t.notificationStatus==='unknown'));
});

test('team Manager identity conflicts and corrupt state fail the whole recovery before host access',async()=>{
 const s=stateWith(2);s.rounds[0].members.find(m=>m.id==='m').binding.threadId='fixture-old-manager';
 await assert.rejects(api().runSupervision(s,manager,()=>assert.fail('no native call')),/Manager/);
 const corrupt=stateWith(2);corrupt.version++;
 assert.throws(()=>api().planSupervision(corrupt,manager));
});
