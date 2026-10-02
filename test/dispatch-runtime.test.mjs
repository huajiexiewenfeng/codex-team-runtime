import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,readFile,rm,readdir,unlink,rename,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createState,evolve,validate,snapshot} from '../src/runtime.mjs';
import {dispatchRuntime,freezeDispatchBrief} from '../src/dispatch-runtime.mjs';
import {readRawState,transact,atomicWrite} from '../src/store.mjs';
import {saveObject,loadObject} from '../src/dispatch-objects.mjs';
import {planDispatch} from '../src/scheduling.mjs';
import {exportDispatchBundle} from '../src/dispatch-export.mjs';
import {render} from '../src/render.mjs';
import {buildStateTimeline} from '../src/task-timeline-state.mjs';
import {prepareSubmissionNotice} from '../src/submission-notice.mjs';
import {hash} from '../src/dispatch-contract.mjs';
const at='2026-10-01T00:00:00.000Z',source={kind:'manual',ref:'synthetic-e04-no-send'},caller={hostId:'test-host',threadId:'manager'};
async function fixture(t){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'e04-')));t.after(async()=>{assert.ok(resolve(dir).startsWith(await realpath(tmpdir())+sep));await rm(dir,{recursive:true,force:true});});
 const statePath=join(dir,'state.json'),registryPath=join(dir,'registry.json');
 let s=createState({teamId:'team',name:'Team',source,members:['Manager','Liaison','Worker'].map(role=>({id:role.toLowerCase(),name:role,role,lifecycle:'active',binding:{status:'bound',hostId:'test-host',threadId:role.toLowerCase()}}))},at);
 s=evolve(s,{id:'open',type:'openRound',actor:'manager',at,source,roundId:'r',title:'Round'},s.version);
 s={...s,schemaVersion:2,registry:{registryId:'registry',registryPath,teamId:'team',migrationId:'migration',sourceSha256:'a'.repeat(64),sourceVersion:s.version,phase:'active',teamRevision:1,readyMemberIds:['manager','worker']}};
 await writeFile(statePath,JSON.stringify(s));await writeFile(registryPath,'fixture');
 const options={at,exporter:async state=>({registryId:'registry',teamId:'team',teamRevision:1,migrationId:'migration',statePath,members:state.members,readyMemberIds:['manager','worker']})};
 const brief={schemaVersion:1,teamId:'team',roundId:'r',taskId:'t',actor:caller,text:' Exact 中文 😀\r\nbody "\\ ',scope:'Authorized fixture task',materialRefs:['fixture-source'],authorizationRef:'fixture-authority',dependencyRef:'fixture-dependencies'};
 const {briefRef}=await freezeDispatchBrief(statePath,brief,options);
 const event={id:'enqueue',type:'enqueue',actor:'manager',caller,at,source:{kind:'manual',ref:briefRef},roundId:'r',taskId:'t',title:'Task',workerId:'worker',required:true,assignedAt:null};
 s=await transact(statePath,s.version,event,options);
 const common={actor_host_id:'test-host',actor_thread_id:'manager',team_id:'team',round_id:'r',task_id:'t',worker_id:'worker',reason:'before_dispatch'};
 const request={...common,action:'prepare',operation_id:'p1',enqueue_event_id:'enqueue',brief_ref:briefRef,admission:{native:{host_id:'test-host',thread_id:'worker',status:'idle',evidence_ref:'fixture-idle'}},baseline:{outcome:'not-attempted',evidence_ref:'fixture-never-sent'}};
 const call=(r,opts={})=>dispatchRuntime({statePath,registryPath,request:r,options:{...options,...opts}});
 const prepare=(extra={},opts={})=>call({...request,...extra},opts);
 const result=(id,outcome='accepted',extra={},opts={})=>call({...common,action:'result',operation_id:'r1',attempt_id:id,result:{outcome,evidence_ref:'fixture-native-result',summary:'Fixture result'},...extra},opts);
 const status=(extra={})=>call({...common,action:'status',...extra});
 const cancel=(id,extra={})=>call({...common,action:'cancel',operation_id:'c1',attempt_id:id,cancellation:{authorization_ref:'fixture-withdrawal',reason:'withdraw',nonreceipt_evidence_ref:'fixture-all-terminal',execution_evidence_ref:'fixture-no-active-or-inflight'},...extra});
 const eventWrite=async event=>{const current=await readRawState(statePath);return transact(statePath,current.version,{actor:'manager',at,source,...event},options);};
 return {dir,statePath,registryPath,options,brief,briefRef,request,common,call,prepare,result,status,cancel,eventWrite};
}
test('E04 first prepare +1, exact body and one send; result +1, replay +0',async t=>{
 const x=await fixture(t),p=await x.prepare();assert.equal(p.sendNow,true,JSON.stringify(p));assert.equal(p.sourceVersion,3);assert.ok(p.hostRequest.arguments.prompt.endsWith(x.brief.text));
 let s=await readRawState(x.statePath);assert.equal(s.events.at(-1).type,'startTask');assert.equal(s.events.at(-1).id,p.attemptId);
 assert.equal((await x.prepare()).sendNow,false);assert.equal((await x.prepare()).hostRequest,undefined);
 assert.equal((await x.result(p.attemptId)).sourceVersion,4);assert.equal((await x.result(p.attemptId)).replayed,true);
 const status=await x.status({operation_id:'p1',attempt_id:p.attemptId,include_content:true});assert.equal(status.delivery,'delivered');assert.equal(status.totalAttemptCount,1);assert.equal(status.retryClaimCount,0);assert.equal(status.brief.text,x.brief.text);assert.equal(status.hostRequest,undefined);
});
test('E04 complete fingerprint conflicts include reason/admission/baseline and cross action',async t=>{
 const x=await fixture(t),p=await x.prepare();
 for(const changed of [{reason:'manual'},{baseline:{outcome:'not-attempted',evidence_ref:'changed'}},{admission:{native:{...x.request.admission.native,evidence_ref:'changed'}}}])assert.equal((await x.prepare(changed)).reasonCode,'OPERATION_CONFLICT');
 assert.equal((await x.result(p.attemptId,'accepted',{operation_id:'p1'})).reasonCode,'OPERATION_CONFLICT');
});
test('E04 missing baseline/admission returns structured input and never writes',async t=>{
 const x=await fixture(t),{baseline,...r}=x.request;assert.equal((await x.call(r)).reasonCode,'HISTORY_REQUIRED');
 const {admission,...r2}=x.request;assert.equal((await x.call(r2)).reasonCode,'NATIVE_CHECK_REQUIRED');assert.equal((await readRawState(x.statePath)).version,2);
});
test('E04 unknown blocks retry; exact terminal result permits one claim, same brief',async t=>{
 const x=await fixture(t),p=await x.prepare(),{baseline,...retry}=x.request;
 assert.equal((await x.call({...retry,operation_id:'p2',retry_of_attempt_id:p.attemptId})).reasonCode,'DELIVERY_UNKNOWN');
 await x.result(p.attemptId,'terminal-not-delivered');const next=await x.call({...retry,operation_id:'p2',retry_of_attempt_id:p.attemptId});assert.equal(next.sendNow,true,JSON.stringify(next));
 const s=await readRawState(x.statePath);assert.equal(s.version,5);assert.equal(s.events.at(-1).type,'deliveryClaim');assert.equal((await x.status()).totalAttemptCount,2);
});
test('E04 concurrency and lost response never grant a second send',async t=>{
 const x=await fixture(t),both=await Promise.all([x.prepare(),x.prepare({operation_id:'p2'})]);assert.equal(both.filter(r=>r.sendNow).length,1);
 const y=await fixture(t),failed=await y.prepare({}, {writeState:async(path,data)=>{await atomicWrite(path,data);throw new Error('lost response');}});
 assert.equal(failed.mutationUnknown,true);assert.equal(failed.hostRequest,undefined);assert.equal((await y.prepare()).sendNow,false);assert.equal((await y.status({operation_id:'p1'})).recorded,true);
});
test('E04 orphan object is not a commit; failed object or state cannot return send',async t=>{
 const x=await fixture(t),bad=await x.prepare({}, {writeState:async()=>{throw new Error('disk failure');}});assert.equal(bad.sendNow,false);assert.equal((await x.status({operation_id:'p1'})).operationCommitted,false);assert.equal((await x.prepare()).sendNow,true);
 const y=await fixture(t);assert.equal((await y.prepare({}, {saveObject:async()=>{throw new Error('object failure');}})).mutationUnknown,false);assert.equal((await readRawState(y.statePath)).version,2);
});
test('E04 damaged or missing committed objects block ordinary store reads and writes',async t=>{
 const x=await fixture(t);await x.prepare();const dir=x.statePath+'.e04-objects',file=(await readdir(dir)).find(f=>f.startsWith('op-'));await unlink(join(dir,file));
 assert.equal((await x.status()).reasonCode,'OBJECT_MISSING');await assert.rejects(readRawState(x.statePath),{code:'OBJECT_MISSING'});
 const y=await fixture(t);await y.prepare();const files=await readdir(y.statePath+'.e04-objects');await writeFile(join(y.statePath+'.e04-objects',files.find(f=>f.startsWith('op-'))),'{}');assert.equal((await y.status()).reasonCode,'OBJECT_CORRUPT');
});
test('E04 late accepted after approve and closed round preserves all business stages',async t=>{
 const x=await fixture(t),p=await x.prepare();
 for(const e of [{id:'submit',type:'submit',actor:'worker',summary:'Done',roundId:'r',taskId:'t'},{id:'review',type:'review',roundId:'r',taskId:'t'},{id:'approve',type:'approve',summary:'Accepted',evidence:['fixture-proof'],roundId:'r',taskId:'t'},{id:'close',type:'closeRound',roundId:'r'}])await x.eventWrite(e);
 const before=await readRawState(x.statePath);const res=await x.result(p.attemptId);assert.equal(res.status,'recorded',JSON.stringify(res));const after=await readRawState(x.statePath);assert.deepEqual(before.tasks,after.tasks);assert.equal(after.rounds[0].status,'closed');
});
test('E04 observations including progress=false forbid negative results and cancellation',async t=>{
 const x=await fixture(t),p=await x.prepare();await x.eventWrite({id:'seen',type:'observe',actor:'worker',roundId:'r',taskId:'t',summary:'Seen',observedAt:at,progress:false});
 assert.equal((await x.result(p.attemptId,'terminal-not-delivered')).status,'error');assert.equal((await x.result(p.attemptId,'denied')).status,'error');assert.equal((await x.cancel(p.attemptId)).status,'error');assert.equal((await x.result(p.attemptId)).status,'recorded');
});
test('E04 policy denial requires explicit proven-undelivered withdrawal; contradictions hold worker',async t=>{
 const x=await fixture(t),p=await x.prepare();assert.equal((await x.result(p.attemptId,'denied')).status,'recorded');
 const {baseline,...retry}=x.request;assert.equal((await x.call({...retry,operation_id:'p2',retry_of_attempt_id:p.attemptId})).sendNow,false);
 const missing=await x.call({...x.common,action:'cancel',operation_id:'c1',attempt_id:p.attemptId});assert.equal(missing.reasonCode,'CANCELLATION_AUTH_REQUIRED');
 assert.equal((await x.cancel(p.attemptId)).reasonCode,'CANCELLED_UNDELIVERED');assert.equal((await x.cancel(p.attemptId)).replayed,true);
 assert.equal((await readRawState(x.statePath)).tasks[0].status,'cancelled');
 const conflict=await x.result(p.attemptId,'accepted',{operation_id:'late'});assert.equal(conflict.reasonCode,'DELIVERY_CONFLICT',JSON.stringify(conflict));assert.equal(conflict.recorded,true);
 assert.ok((await x.status()).dispatchHold);assert.equal((await x.result(p.attemptId,'accepted',{operation_id:'late'})).replayed,true);
 await x.eventWrite({id:'q2',type:'enqueue',caller,roundId:'r',taskId:'t2',title:'Next',workerId:'worker',required:true,assignedAt:null});
 await assert.rejects(x.eventWrite({id:'start2',type:'startTask',caller,roundId:'r',taskId:'t2'}),/Dispatch conflict hold/);
 assert.equal(planDispatch(await readRawState(x.statePath),caller,'worker').decision,'held');
});
test('E04 old delivery API cannot claim or record E04 attempts, even after nonreceipt',async t=>{
 const x=await fixture(t),p=await x.prepare();
 await assert.rejects(x.eventWrite({id:'old',type:'deliveryCheck',caller,roundId:'r',taskId:'t',attemptId:p.attemptId,outcome:'not-delivered',summary:'Old'}),/E04 attempts/);
 await x.result(p.attemptId,'terminal-not-delivered');await assert.rejects(x.eventWrite({id:'oldclaim',type:'deliveryClaim',caller,roundId:'r',taskId:'t',attemptId:p.attemptId,summary:'Old'}),/E04 attempts/);
});
test('E04 no fabricated source clock or hard TTL; future evidence and wrong identity rejected',async t=>{
 const x=await fixture(t);assert.equal((await x.prepare({actor_thread_id:'worker'})).reasonCode,'IDENTITY_CONFLICT');
 assert.equal((await x.prepare({admission:{native:{...x.request.admission.native,observed_at:'2027-01-01T00:00:00Z'}}})).status,'error');
 const good=await x.prepare({admission:{native:{...x.request.admission.native,observed_at:'2026-09-30T23:58:00Z'}}});assert.equal(good.sendNow,true);assert.equal(good.observationAgeMs,120000);
});
test('E04 FIFO and unapproved work protection remain in common evolve',async t=>{
 const x=await fixture(t);await x.eventWrite({id:'q2',type:'enqueue',caller,roundId:'r',taskId:'t2',title:'Next',workerId:'worker',required:true,assignedAt:null});
 await assert.rejects(x.eventWrite({id:'s2',type:'startTask',caller,roundId:'r',taskId:'t2'}),/FIFO/);await x.prepare();await assert.rejects(x.eventWrite({id:'s2',type:'startTask',caller,roundId:'r',taskId:'t2'}),/busy/);
});
test('E04 complete export retains objects, verifies restored bytes and never overwrites',async t=>{
 const x=await fixture(t),p=await x.prepare();await x.result(p.attemptId);
 const out=join(x.dir,'backup'),manifest=await exportDispatchBundle(x.statePath,out,x.options);
 assert.equal(manifest.objects.length,3);assert.equal((await readRawState(join(out,'state.json'))).version,4);
 await assert.rejects(exportDispatchBundle(x.statePath,out,x.options),{code:'EEXIST'});
});
test('E04 existing queued brief requires exact original enqueue and source',async t=>{
 const x=await fixture(t),state=await readRawState(x.statePath);state.events.at(-1).source=source;await writeFile(x.statePath,JSON.stringify(state));
 assert.equal((await x.prepare()).reasonCode,'BRIEF_MISMATCH');
 const frozen=await freezeDispatchBrief(x.statePath,{...x.brief,enqueueEventId:'enqueue',originalSourceRef:source.ref},x.options);
 assert.equal((await x.prepare({brief_ref:frozen.briefRef})).sendNow,true);
 await assert.rejects(freezeDispatchBrief(x.statePath,x.brief,x.options),{code:'TASK_ADVANCED'});
});
test('E04 E03 notice and offline dashboard/timeline accept late transport audits',async t=>{
 const x=await fixture(t),p=await x.prepare();await x.eventWrite({id:'submit',type:'submit',actor:'worker',roundId:'r',taskId:'t',summary:'Done'});await x.result(p.attemptId);
 const state=await readRawState(x.statePath);assert.equal(prepareSubmissionNotice(state,{hostId:'test-host',threadId:'worker'},'t').notice.submissionId,'submit');
 assert.ok(render(snapshot(state,at)).includes('已确认送达'));
 assert.ok(buildStateTimeline(state,{teamId:'team',roundId:'r',taskId:'t'}));
});
test('E04 frozen E03 reader accepts initial marker and can bypass old writer; new outcomes reject',async t=>{
 const x=await fixture(t);
 // Exact old runtime + old delivery projection, not aliases to updated modules.
 const uri=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
 const digests={'delivery-state.mjs':'8dc4494e1cbf373040e26305901f00380d1537fc77fddedaff64b3831894a4eb','runtime.mjs':'39f66f7e09e7eec3562bb9e5a5cfd23d1f321f10bf98980e9e1dd6f4cee7ee2a','worker-revocation.mjs':'2ccd330ef15a59b92bd9f540edb5ce7405fb09d589ecd9da70fd66342c1887de'};
 const oldSource=async name=>{const source=(await readFile(new URL('./fixtures/e04-legacy-7dd69ad/'+name+'.txt',import.meta.url),'utf8')).replace(/\r\n/g,'\n');assert.equal(hash(source),digests[name]);return source;};
 const delivery=uri(await oldSource('delivery-state.mjs')),revocation=uri(await oldSource('worker-revocation.mjs'));
 const old=await import(uri((await oldSource('runtime.mjs')).replace('./delivery-state.mjs',delivery).replace('./worker-revocation.mjs',revocation)));
 const p=await x.prepare(),state=await readRawState(x.statePath);old.validate(state);
 const check={id:'oldcheck',type:'deliveryCheck',actor:'manager',caller,at,source,roundId:'r',taskId:'t',attemptId:p.attemptId,outcome:'not-delivered',summary:'Old writer ignores E04 objects'};
 const bypass=old.evolve(state,check,state.version);assert.equal(bypass.version,state.version+1);
 assert.throws(()=>evolve(state,check,state.version),/E04 attempts/);
 await x.result(p.attemptId,'denied');const denied=await readRawState(x.statePath);assert.throws(()=>old.validate(denied),/Invalid delivery outcome/);
 await x.cancel(p.attemptId);const cancelled=await readRawState(x.statePath);assert.throws(()=>old.validate(cancelled));
});
test('E04 material size, unsafe references and reparse directories fail closed',async t=>{
 const x=await fixture(t);await assert.rejects(freezeDispatchBrief(x.statePath,{...x.brief,text:'中'.repeat(22000)},x.options),{code:'PAYLOAD_TOO_LARGE'});
 assert.equal((await x.prepare({brief_ref:'../../elsewhere'})).status,'error');
 const dir=x.statePath+'.e04-objects',moved=join(x.dir,'moved-objects');await rename(dir,moved);await symlink(moved,dir,process.platform==='win32'?'junction':'dir');
 assert.equal((await x.prepare()).reasonCode,'OBJECT_CORRUPT');
});
test('E04 explicit selectors do not guess correlation; read-only status leaves unknown lock',async t=>{
 const x=await fixture(t),p=await x.prepare();assert.equal((await x.status()).correlationVerified,false);
 assert.equal((await x.status({attempt_id:'wrong'})).reasonCode,'ATTEMPT_NOT_FOUND');
 await writeFile(x.statePath+'.lock','unknown-owner');assert.equal((await x.status({operation_id:'p1'})).attemptId,p.attemptId);assert.equal(await readFile(x.statePath+'.lock','utf8'),'unknown-owner');
});
test('E04 late receipt survives Worker readiness loss while new sends remain fenced',async t=>{
 const x=await fixture(t),p=await x.prepare();
 const exporter=async s=>({...await x.options.exporter(s),teamRevision:2,readyMemberIds:['manager']});
 const result=await x.result(p.attemptId,'accepted',{}, {exporter});assert.equal(result.status,'recorded',JSON.stringify(result));
 assert.deepEqual((await readRawState(x.statePath)).registry.readyMemberIds,['manager']);
 const y=await fixture(t);const blocked=await y.prepare({}, {exporter:async s=>({...await y.options.exporter(s),teamRevision:2,readyMemberIds:['manager']})});assert.equal(blocked.sendNow,false);assert.equal((await readRawState(y.statePath)).version,2);
});
