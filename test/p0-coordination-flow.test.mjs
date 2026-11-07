import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fixture,caller} from './manager-operations-helper.mjs';
import {evolve} from '../src/runtime.mjs';
import {planSupervision,readSupervisionPlan} from '../src/supervision.mjs';

const template=await readFile(new URL('../skills/manager-session/scripts/functions-exec-wait-template.js',import.meta.url),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const sentinel='PRIVATE_FIXTURE_BODY';
function ok(result) {
  assert.notEqual(result.status,'error',JSON.stringify(result));
  return result;
}
async function start(f,taskId,workerId) {
  const queued=await f.enqueue({taskId,workerId});
  ok(queued.result);
  ok((await f.dispatch(queued)).result);
}
async function observe(plan) {
  assert.equal(plan.batches.length,1);
  const [request]=plan.batches;
  const calls=[],output=[];
  const script=template.replace('const request = {targets: [], timeoutMs: 0};',
    'const request = '+JSON.stringify(request)+';');
  await new AsyncFunction('tools','text',script)({
    mcp__codex_app__wait_threads: async args=>{
      calls.push(args);
      return {structuredContent:{timedOut:false,wake:null,polls:[...args.targets].reverse().map(target=>({
        schemaVersion:1,cursor:'cursor-'+target.threadId,revision:1,changed:true,
        thread:{id:target.threadId,hostId:target.hostId,status:{type:'idle'}},
        latestTurn:{id:'turn-'+target.threadId,status:'completed',error:null,body:sentinel},
        finalReply:sentinel,
      }))}};
    },
  },value=>output.push(value));
  assert.deepEqual(calls,[request]);
  assert.equal(output.length,1);
  assert.ok(!JSON.stringify(output).includes(sentinel));
  assert.deepEqual(output[0].targets.map(x=>[x.threadId,x.turn.status,x.submissionRef]),
    request.targets.map(x=>[x.threadId,'completed',null]));
}

test('unnotified out-of-order submissions survive supervision and recover exact review across the queue checkpoint',async t=>{
  const f=await fixture(t,'queue_first');
  await start(f,'t','w');
  await start(f,'t2','w2');
  const second=await f.event('submit',{taskId:'t2',summary:'second Worker first to finish'},'w2');
  const first=await f.event('submit',{summary:'first Worker second to finish'},'w');
  const plan=await readSupervisionPlan(f.statePath,caller,[],{...f.options,notifications:true});
  assert.deepEqual(plan.pendingSubmissions.notices.map(x=>[x.taskId,x.submissionId]),
    [['t',first.id],['t2',second.id]]);
  assert.ok(plan.taskChecks.every(x=>x.notificationStatus==='unknown'));
  await observe(plan);
  // Recovery orders the inbox by firstPendingSeq, not by business submit order.
  const checkpoint=ok(await f.inbox('checkpoint',{
    run_id:'run',expected_control_revision:(await f.ledger()).controlRevision,trigger:'step_complete',
  }));
  const expected=new Map([
    ['t',{workerId:'w',submissionId:first.id}],
    ['t2',{workerId:'w2',submissionId:second.id}],
  ]);
  assert.deepEqual(new Map(checkpoint.items.map(x=>[x.taskId,x.submissionId])),
    new Map([...expected].map(([taskId,x])=>[taskId,x.submissionId])));
  assert.equal(checkpoint.items.length,2);
  const [head,tail]=checkpoint.items;
  assert.ok(head.firstPendingSeq<tail.firstPendingSeq);

  const beforeClaim=await f.raw(), inboxBeforeClaim=await f.ledger();
  const claimItem=item=>f.inbox('claim',{
    run_id:'run',generation:inboxBeforeClaim.consumer.generation,
    expected_control_revision:inboxBeforeClaim.controlRevision,expected_work_id:inboxBeforeClaim.activeWorkId,
    checkpoint_id:checkpoint.checkpointId,item_id:item.itemId,payload_seq:item.payloadSeq,
    boundary_ref:'fixture independent review boundary',
  });
  const rejected=await claimItem(tail);
  assert.equal(rejected.status,'error');
  assert.equal(rejected.reasonCode,'FIFO_CONFLICT');
  assert.deepEqual(await f.raw(),beforeClaim);
  assert.deepEqual(await f.ledger(),inboxBeforeClaim);

  const {claim}=ok(await claimItem(head));
  const request=await f.base('receive',{
    taskId:head.taskId,...expected.get(head.taskId),
    claim:{runId:claim.runId,generation:claim.generation,claimId:claim.id,itemId:claim.itemId},
  });
  const received=ok(await f.call(request));
  const replay=ok(await f.call(request));
  assert.equal(replay.replayed,true);
  assert.equal(replay.eventId,received.eventId);
  const state=await f.raw(),after=planSupervision(state,caller);
  assert.deepEqual(new Map(after.taskChecks.map(x=>[x.taskId,x.nextAction])),
    new Map([[head.taskId,'continue-review'],[tail.taskId,'inspect-submission']]));
  assert.deepEqual(after.pendingSubmissions.notices.map(x=>[x.taskId,x.submissionId]),
    [[tail.taskId,expected.get(tail.taskId).submissionId]]);
  assert.deepEqual(state.events.filter(x=>x.type==='review').map(x=>[x.taskId,x.id]),
    [[head.taskId,received.eventId]]);
});

test('idle completed turn keeps unsubmitted execution and rework discoverable without creating review work',async t=>{
  const f=await fixture(t);
  const initial=await f.raw();
  const at=initial.updatedAt;
  const step=(state,type,taskId,actor,fields={})=>evolve(state,{
    id:type+'-'+taskId,type,taskId,actor,at,source:f.source,roundId:'r',...fields,
  },state.version);
  let state=step(initial,'assign','t','m',{workerId:'w',title:'Task 1',required:true,assignedAt:at});
  state=step(state,'assign','t2','m',{workerId:'w2',title:'Task 2',required:true,assignedAt:at});
  state=step(state,'submit','t2','w2',{summary:'needs correction'});
  state=step(state,'review','t2','m');
  state=step(state,'rework','t2','m',{summary:'correct the evidence'});
  const before=structuredClone(state),plan=planSupervision(state,caller);
  assert.deepEqual(plan.taskChecks.map(x=>[x.taskId,x.taskStatus,x.nextAction]),
    [['t','executing','check-progress'],['t2','rework','check-progress']]);
  assert.deepEqual(plan.pendingSubmissions.notices,[]);
  await observe(plan);
  assert.deepEqual(state,before);
});
