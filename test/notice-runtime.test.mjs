import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createState,evolve } from '../src/runtime.mjs';
import { noticeRuntime } from '../src/notice-runtime.mjs';
import { prepareSubmissionNotice, planSubmissionReview, pendingSubmissions } from '../src/submission-notice.mjs';
import { validateLedger } from '../src/submission-recovery.mjs';
import { withFileLocks } from '../src/registry-projection.mjs';
import { parseNoticeJson } from '../src/notice-json.mjs';
import { buildNoticeTimeline, noticeMismatchObservation } from '../src/notice-timeline.mjs';
import { collectTaskTimeline } from '../src/task-timeline-input.mjs';
import { renderTimelineMarkdown } from '../src/task-timeline.mjs';
import { renderDashboardTimeline } from '../src/dashboard-timeline.mjs';

// Frozen 82bd910 module, not aliases to the new implementation. Resolve only
// its relative dependencies to the shared store/runtime, preserving old logic.
const legacySource=(await readFile(new URL('./fixtures/e03-legacy-recovery-82bd910.txt',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
assert.equal(createHash('sha256').update(legacySource).digest('hex'),'ec9a3bce18d1b03b12935700e2938ae9b58355a02e7d04ca6169688686657e4e');
const legacyModule=legacySource.replace(/(['"])\.\/([^'"]+)\1/g,(_match,quote,path)=>quote+new URL('../src/'+path,import.meta.url).href+quote);
const {recordNoticeResult,trackSubmissionNotice,claimNoticeDelivery,readNoticeEvidence}=await import('data:text/javascript;base64,'+Buffer.from(legacyModule).toString('base64'));

const at='2026-10-01T00:00:00.000Z';
const source={kind:'manual',ref:'synthetic-e03-test-no-native-send'};
const worker={hostId:'test-host',threadId:'test-worker'}, manager={hostId:'test-host',threadId:'test-manager'};
const evidence={kind:'host-result',ref:'synthetic-call',detail:'Synthetic acceptance'};
const accepted={outcome:'accepted',evidence};
const baseline={outcome:'not-attempted',evidence:{kind:'observation',ref:'submission-1',detail:'Synthetic verified initial send'}};
const transient={outcome:'transient-not-delivered',evidence:{...evidence,kind:'terminal-nonreceipt',notReceived:true,cannotArrive:true,temporary:true}};
async function fixture(t,summary='  中文 😀\r\nline\n"\\ 2026-01-01T00:00:00.123Z  ') {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'e03-core-')));
  t.after(async()=>{assert.ok(resolve(dir).startsWith(await realpath(tmpdir())+sep));await rm(dir,{recursive:true,force:true});});
  const statePath=join(dir,'state.json'),registryPath=join(dir,'registry.json');
  let state=createState({teamId:'team',name:'Team',source,members:[
    {id:'m',role:'Manager',name:'Manager',lifecycle:'active',binding:{status:'bound',...manager}},
    {id:'l',role:'Liaison',name:'Liaison',lifecycle:'active',binding:{status:'bound',hostId:'test-host',threadId:'test-liaison'}},
    {id:'w',role:'Worker',name:'Worker',lifecycle:'active',binding:{status:'bound',...worker}}]},at);
  for(const event of [{id:'open',type:'openRound',roundId:'r',title:'Round'},
    {id:'assign',type:'assign',roundId:'r',taskId:'t',title:'Task',workerId:'w',required:true,assignedAt:at},
    {id:'submission-1',type:'submit',roundId:'r',taskId:'t',summary,actor:'w'}]) state=evolve(state,{actor:'m',at,source,...event},state.version);
  state={...state,schemaVersion:2,registry:{registryId:'registry',registryPath,teamId:'team',migrationId:'migration',sourceSha256:'a'.repeat(64),sourceVersion:state.version,phase:'active',teamRevision:1,readyMemberIds:['m','l','w']}};
  await writeFile(statePath,JSON.stringify(state)); await writeFile(registryPath,'synthetic-placeholder');
  const options={at,exporter:async s=>({registryId:'registry',teamId:'team',teamRevision:1,migrationId:'migration',statePath,members:s.members,readyMemberIds:['m','l','w']})};
  const request={action:'prepare',actor_host_id:worker.hostId,actor_thread_id:worker.threadId,team_id:'team',task_id:'t',submission_id:'submission-1',reason:'before_delivery',operation_id:'prepare-1',baseline};
  const call=(extra={},opts={})=>noticeRuntime({statePath,registryPath,request:{...request,...extra},options:{...options,...opts}});
  const status=(extra={})=>{const {operation_id,baseline,...r}=request;return noticeRuntime({statePath,registryPath,request:{...r,action:'status',...extra},options});};
  const result=(attemptId,extra={})=>{const {baseline,...r}=request;return noticeRuntime({statePath,registryPath,request:{...r,action:'result',operation_id:'result-1',attempt_id:attemptId,result:accepted,...extra},options});};
  const ledger=()=>readFile(statePath+'.submission-notices.json','utf8').then(JSON.parse);
  return {dir,state,statePath,registryPath,request,call,status,result,ledger,options};
}
test('T1/T2 real disk roundtrip preserves exact content, versions and business state',async t=>{
 const x=await fixture(t),before=await readFile(x.statePath,'utf8'); const p=await x.call();
 assert.equal(p.status,'ready_to_send',JSON.stringify(p));assert.equal(p.ledgerVersion,2);
 assert.deepEqual(p.hostRequest,prepareSubmissionNotice(x.state,worker,'t').hostRequest);
 assert.equal(p.contentSha256,createHash('sha256').update(x.state.events.at(-1).summary).digest('hex'));
 const r=await x.result(p.attemptId);assert.equal(r.status,'recorded',JSON.stringify(r));assert.equal(r.ledgerVersion,3);
 const s=await x.status({prepare_operation_id:'prepare-1',include_content:true});assert.equal(s.notificationOutcome,'accepted');assert.equal(s.attemptId,p.attemptId);assert.equal(s.sendNow,undefined);assert.equal(s.hostRequest,undefined);
 assert.equal(await readFile(x.statePath,'utf8'),before);validateLedger(await x.ledger(),x.statePath,'team');
});
test('T3 replay never exposes another send, conflicting IDs cannot mutate',async t=>{
 const x=await fixture(t),p=await x.call(); const replay=await x.call();assert.equal(replay.attemptId,p.attemptId);assert.equal(replay.sendNow,undefined);assert.equal(replay.hostRequest,undefined);
 assert.equal((await x.call({reason:'manual'})).reasonCode,'OPERATION_CONFLICT');
 await x.result(p.attemptId);const before=JSON.stringify(await x.ledger());assert.equal((await x.result(p.attemptId)).replayed,true);assert.equal(JSON.stringify(await x.ledger()),before);
 assert.equal((await x.result(p.attemptId,{operation_id:'prepare-1'})).reasonCode,'OPERATION_CONFLICT');
});
test('T3 concurrent claims yield at most one send permission',async t=>{
 const x=await fixture(t);const results=await Promise.all([x.call(),x.call({operation_id:'prepare-2'})]);
 assert.equal(results.filter(r=>r.sendNow).length,1);assert.equal((await x.ledger()).entries[0].attempts.length,1);
});
test('T2/T4 missing baseline and wrong caller/submission are nonmutating',async t=>{
 const x=await fixture(t);const {baseline,...request}=x.request;
 const missing=await noticeRuntime({...x,request,options:x.options});assert.equal(missing.reasonCode,'HISTORY_REQUIRED');assert.ok(missing.requiredInput);
 assert.equal((await x.call({submission_id:'wrong'})).reasonCode,'SUBMISSION_CHANGED');
 assert.equal((await x.call({actor_thread_id:'test-liaison'})).reasonCode,'IDENTITY_CONFLICT');
 await assert.rejects(x.ledger(),{code:'ENOENT'});
});
test('T3 failed atomic write cannot expose request or persist half a claim',async t=>{
 const x=await fixture(t);const p=await x.call({}, {writeLedger:async()=>{throw new Error('injected disk failure');}});
 assert.equal(p.status,'error');assert.equal(p.hostRequest,undefined);assert.equal(p.mutationUnknown,true);await assert.rejects(x.ledger(),{code:'ENOENT'});
});
test('T5 oversize and invalid Unicode never consume an attempt',async t=>{
 const x=await fixture(t);assert.equal((await x.call({baseline:{...baseline,evidence:{...baseline.evidence,detail:'x'.repeat(1024*1024)}}})).reasonCode,'PAYLOAD_TOO_LARGE');await assert.rejects(x.ledger(),{code:'ENOENT'});
 const y=await fixture(t);assert.equal((await y.call({baseline:{...baseline,evidence:{...baseline.evidence,detail:'\ud800'}}})).reasonCode,'INVALID_REQUEST');
});
test('T4 unknown cannot retry; exact nonreceipt respects cooldown and attempt budget',async t=>{
 const x=await fixture(t);const p=await x.call();assert.equal((await x.call({operation_id:'p2'})).reasonCode,'DELIVERY_UNKNOWN');
 await x.result(p.attemptId,{result:transient});assert.equal((await x.call({operation_id:'p2'})).reasonCode,'COOLDOWN');
 const p2=await x.call({operation_id:'p2'},{at:'2026-10-01T00:00:05.000Z'});assert.equal(p2.sendNow,true,JSON.stringify(p2));
});
test('T7 legacy result and new prepare interoperate without invented mapping',async t=>{
 const x=await fixture(t),p=await x.call();const notice=prepareSubmissionNotice(x.state,worker,'t').notice;
 await recordNoticeResult({statePath:x.statePath,caller:worker,notice,expectedVersion:x.state.version,expectedLedgerVersion:2,attemptId:p.attemptId,result:accepted,at,options:x.options});
 const before=JSON.stringify(await x.ledger());const r=await x.result(p.attemptId);assert.equal(r.alreadyRecorded,true);assert.equal(r.operationRecorded,false);assert.equal(JSON.stringify(await x.ledger()),before);
 assert.equal((await x.result(p.attemptId,{result:{...accepted,evidence:{...evidence,ref:'other'}}})).reasonCode,'RESULT_CONFLICT');
 assert.equal((await x.status({prepare_operation_id:'prepare-1'})).notificationOutcome,'accepted');
});
test('T7 old claim can be recorded by new result without a fabricated prepare ID',async t=>{
 const x=await fixture(t),notice=prepareSubmissionNotice(x.state,worker,'t').notice;
 const args={statePath:x.statePath,caller:worker,notice,expectedVersion:x.state.version,at,options:x.options};
 await trackSubmissionNotice({...args,expectedLedgerVersion:0,baseline});
 const p=await claimNoticeDelivery({...args,expectedLedgerVersion:1});
 assert.equal((await x.result(p.attemptId)).status,'recorded');
 const s=await x.status({attempt_id:p.attemptId});assert.equal(s.operationMappingAvailable,false);assert.equal(s.prepareOperationId,undefined);
});
test('T8 selectors and latest hint cannot misattribute an attempt',async t=>{
 const x=await fixture(t),p=await x.call();const s=await x.status();assert.equal(s.latestAttemptId,p.attemptId);assert.equal(s.correlationVerified,false);assert.equal(s.attemptId,undefined);
 assert.equal((await x.status({prepare_operation_id:'absent'})).reasonCode,'OPERATION_NOT_FOUND');
 assert.equal((await x.status({prepare_operation_id:'prepare-1',attempt_id:'wrong'})).reasonCode,'ATTEMPT_NOT_FOUND');
 assert.equal((await x.call({operation_id:'bad/id'})).reasonCode,'INVALID_REQUEST');
 assert.equal((await x.call({statePath:'arbitrary'})).reasonCode,'INVALID_REQUEST');
});
test('T4 Manager may record after reviewing starts; no business rollback',async t=>{
 const x=await fixture(t),p=await x.call(),notice=prepareSubmissionNotice(x.state,worker,'t').notice;
 const next=evolve(x.state,{id:'review',type:'review',actor:'m',at,source,roundId:'r',taskId:'t'},x.state.version);await writeFile(x.statePath,JSON.stringify(next));
 const before=await readFile(x.statePath,'utf8');const r=await x.result(p.attemptId,{actor_thread_id:manager.threadId});assert.equal(r.status,'recorded',JSON.stringify(r));assert.equal(await readFile(x.statePath,'utf8'),before);
 assert.equal((await x.call({operation_id:'later'})).reasonCode,'ALREADY_REVIEWING');
});

test('T3 lost response after durable write recovers only by exact operation',async t=>{
 const x=await fixture(t);
 const result=await x.call({}, {lockRunner:async(paths,operation)=>{
   await withFileLocks(paths,operation);throw new Error('injected response/cleanup failure');
 }});
 assert.equal(result.status,'error');assert.equal(result.mutationUnknown,true);assert.equal(result.sendNow,undefined);
 const restored=await x.status({prepare_operation_id:'prepare-1'});assert.equal(restored.notificationOutcome,'unknown');
 assert.ok(restored.attemptId);assert.equal((await x.call()).sendNow,undefined);assert.equal((await x.ledger()).version,2);
});

test('T4 terminal nonreceipt alone permits exactly three attempts and denies a fourth',async t=>{
 const x=await fixture(t);let p=await x.call();
 for(let i=0;i<3;i++){
   const seconds=i===0?0:i===1?5:20;
   const atTime=new Date(Date.parse(at)+seconds*1000).toISOString();
   const {baseline,...r}=x.request;
   const result=await noticeRuntime({...x,request:{...r,action:'result',operation_id:'r'+i,attempt_id:p.attemptId,result:transient},options:{...x.options,at:atTime}});
   assert.equal(result.status,'recorded',JSON.stringify(result));
   p=await x.call({operation_id:'p'+(i+2)},{at:new Date(Date.parse(at)+(i===0?5:i===1?20:40)*1000).toISOString()});
 }
 assert.equal(p.reasonCode,'ATTEMPT_LIMIT');assert.equal((await x.ledger()).entries[0].attempts.length,3);
});

test('T4 denied result and incomplete nonreceipt evidence cannot enable sending',async t=>{
 const x=await fixture(t),p=await x.call();
 assert.equal((await x.result(p.attemptId,{result:{outcome:'transient-not-delivered',evidence}})).status,'error');
 await x.result(p.attemptId,{result:{outcome:'policy-denied',evidence}});
 assert.equal((await x.call({operation_id:'new-id'})).reasonCode,'POLICY_DENIED');
});

test('T8 raw adapter JSON rejects duplicates, trailing commas and deep nesting',()=>{
 for(const text of ['{"x":1,"x":2}','{"x":1,}','[1,]','['.repeat(101)+'0'+']'.repeat(101)]) assert.throws(()=>parseNoticeJson(text));
 assert.deepEqual(parseNoticeJson('{"a":[1,true,null,"x"],"b":-1.25}'),{a:[1,true,null,'x'],b:-1.25});
});

test('T7 new result survives an old writer append and replays its original receipt',async t=>{
 const x=await fixture(t),p=await x.call();
 const unknown={outcome:'unknown',evidence:{kind:'observation',ref:'incomplete-call',detail:'No terminal evidence'}};
 const first=await x.result(p.attemptId,{result:unknown});
 const notice=prepareSubmissionNotice(x.state,worker,'t').notice;
 await recordNoticeResult({statePath:x.statePath,caller:worker,notice,expectedVersion:x.state.version,expectedLedgerVersion:3,attemptId:p.attemptId,result:accepted,at,options:x.options});
 const replay=await x.result(p.attemptId,{result:unknown});
 assert.equal(replay.ledgerVersion,first.ledgerVersion);assert.deepEqual(replay.result,unknown);assert.equal(replay.replayed,true);
 assert.equal((await x.status({attempt_id:p.attemptId})).notificationOutcome,'accepted');
 assert.equal((await readNoticeEvidence(x.statePath,x.state,manager,['t'])).tasks[0].notificationStatus,'accepted');
 assert.equal((await x.ledger()).version,4);
});

test('T8 corrupt persisted response fails closed and cannot supply hostRequest',async t=>{
 const x=await fixture(t),p=await x.call();await x.result(p.attemptId);
 const ledger=await x.ledger();ledger.e03.operations[1].response.hostRequest={prompt:'untrusted replacement'};
 await writeFile(x.statePath+'.submission-notices.json',JSON.stringify(ledger));
 for(const out of [await x.result(p.attemptId),await x.status()]){
   assert.equal(out.reasonCode,'STORAGE_CORRUPT');assert.equal(out.hostRequest,undefined);
 }
});

test('T9 mismatch remains distinct from identity failure and pending review preserves unknown delivery',async t=>{
 const x=await fixture(t),p=await x.call(),notice=prepareSubmissionNotice(x.state,worker,'t').notice;
 assert.throws(()=>planSubmissionReview(x.state,manager,{...notice,summary:'changed'}),{code:'NOTICE_MISMATCH',message:'Notice does not match durable submission'});
 assert.throws(()=>planSubmissionReview(x.state,worker,notice),e=>e.code!=='NOTICE_MISMATCH');
 const pending=pendingSubmissions(x.state,manager);assert.deepEqual(pending.notices,[notice]);
 assert.equal(planSubmissionReview(x.state,manager,pending.notices[0]).action,'review');
 assert.equal((await x.status({attempt_id:p.attemptId})).notificationOutcome,'unknown');
 assert.equal((await x.ledger()).entries[0].attempts.length,1);
});

test('T8 key order is canonical but changed evidence is an operation conflict',async t=>{
 const x=await fixture(t),p=await x.call();
 const reordered=Object.fromEntries(Object.entries(x.request).reverse());
 reordered.baseline={evidence:Object.fromEntries(Object.entries(baseline.evidence).reverse()),outcome:'not-attempted'};
 const replay=await noticeRuntime({...x,request:reordered,options:x.options});assert.equal(replay.attemptId,p.attemptId);assert.equal(replay.replayed,true);
 assert.equal((await x.call({baseline:{...baseline,evidence:{...baseline.evidence,detail:baseline.evidence.detail+' '}}})).reasonCode,'OPERATION_CONFLICT');
});

test('notification timing preserves measurement meaning and exports no content',async t=>{
 const x=await fixture(t),p=await x.call();await x.result(p.attemptId);
 const ledger=await x.ledger();const report=buildNoticeTimeline(x.state,ledger,{statePath:x.statePath,taskId:'t',ledgerBytes:Buffer.byteLength(JSON.stringify(ledger))});
 assert.deepEqual(report.intervals.map(i=>i.kind),['submit-to-claim','claim-to-result']);
 assert.equal(report.intervals[1].includesAgentScheduling,true);assert.equal(report.hostSendDurationMs,null);assert.equal(report.noticeMismatchCount,null);
 assert.equal(JSON.stringify(report).includes(x.state.events.at(-1).summary),false);
});

test('notice mismatch observation needs an exact structured failed receive result',()=>{
 const item={type:'commandExecution',command:'node src/cli.mjs receive-submission state caller notice event 3',exitCode:1,
   aggregatedOutput:JSON.stringify({code:'NOTICE_MISMATCH',message:'Notice does not match durable submission'})};
 assert.equal(noticeMismatchObservation(item),'NOTICE_MISMATCH');
 for(const patch of [{exitCode:0},{command:'node other.mjs'},{aggregatedOutput:'Error: Notice does not match durable submission'},
   {aggregatedOutput:'{"code":"IDENTITY_CONFLICT","message":"Notice does not match durable submission"}'}])assert.equal(noticeMismatchObservation({...item,...patch}),null);
});

test('explicit timeline sources integrate ledger and native mismatch without leaking content',async t=>{
 const x=await fixture(t),p=await x.call();await x.result(p.attemptId);
 const sourcePath=join(x.dir,'source.jsonl'),nativePath=join(x.dir,'native.json');
 await writeFile(sourcePath,JSON.stringify({type:'session_meta',payload:{id:manager.threadId}})+'\n');
 const item={id:'receive',type:'commandExecution',command:'node cli.mjs receive-submission private-path',exitCode:1,status:'failed',durationMs:2,
   aggregatedOutput:JSON.stringify({code:'NOTICE_MISMATCH',message:'Notice does not match durable submission'})};
 await writeFile(nativePath,JSON.stringify({schemaVersion:1,thread:{id:manager.threadId,hostId:manager.hostId},turns:[{id:'turn',items:[item]}]}));
 const report=await collectTaskTimeline({teamId:'team',taskId:'t',sources:[{path:sourcePath,sourceRef:'manager-log',...manager,role:'Manager',from:at,to:'2026-10-02T00:00:00.000Z'}],
   stateSource:{path:x.statePath,roundId:'r'},noticeSource:{path:x.statePath+'.submission-notices.json'},
   nativeSources:[{path:nativePath,sourceRef:'manager-receive',...manager,role:'Manager',turnId:'turn',itemIds:['receive']}]},x.dir);
 assert.equal(report.noticeTimeline.attemptCount,1);assert.equal(report.noticeReceiveObservation.noticeMismatchCount,1);
 assert.equal(JSON.stringify(report).includes('private-path'),false);
 assert.match(renderTimelineMarkdown(report),/NOTICE_MISMATCH：1/);assert.match(renderDashboardTimeline(report),/NOTICE_MISMATCH：1/);
});
