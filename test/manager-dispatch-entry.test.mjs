import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,access,unlink} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {fixture} from './manager-operations-helper.mjs';
import {managerOperationsBridge} from '../scripts/manager-operations-bridge.mjs';
import {fingerprint} from '../src/manager-operations-contract.mjs';
import {dispatchEntryStage} from '../src/manager-dispatch-entry.mjs';
const source=await readFile(new URL('../scripts/manager-operations-functions-exec.js',import.meta.url),'utf8');
const load=()=>runInNewContext(source+'\nrunManagerDispatch;',{},{timeout:1000});
async function setup(t,mode='legacy',teamId='synthetic-a'){
 const f=await fixture(t,mode,{teamId}),e=structuredClone(await f.base('enqueue',{taskId:'new-task',title:'Independent authorized task',required:true}));
 const input={statePath:f.statePath,enqueueInput:e,
  brief:{schemaVersion:1,teamId,roundId:'r',taskId:e.taskId,actor:e.caller,text:'Original 中文\r\n $ literal ` 😀',scope:'offline only',materialRefs:['synthetic:material'],authorizationRef:'synthetic:authorization',dependencyRef:'synthetic:dependency'},
  prepareInput:{operation_id:'stable-prepare',reason:'before_dispatch',admission:{native:{host_id:'fake-host',thread_id:'fake-w',status:'idle',evidence_ref:'synthetic:idle'}},baseline:{outcome:'not-attempted',evidence_ref:'synthetic:no-inflight'}},hostEvidencePath:f.root+'/native.json'};
 const requestFile=f.root+'/request.json',args={tools:null,nodeExecutable:'C:/node.exe',pythonExecutable:'C:/verified/python.exe',runtimeRoot:'C:/verified/runtime',requestFile,input,hostSendAuthorized:true,authorizationRef:'synthetic:existing-authorization'};
 return {...f,input,args,requestFile};
}
function harness(f,{native='accepted',fault,afterFault}={}){
 let sends=0;const actions=[];
 const tools={exec_command:async({cmd})=>{
  const argv=[...cmd.matchAll(/'((?:[^']|'')*)'/g)].map(m=>m[1].replace(/''/g,"'"));
  const action=argv[2],payload=JSON.parse(Buffer.from(argv[4],'base64').toString('utf8'));actions.push(action);
  if(fault?.(action,payload))throw Error('synthetic transport interruption');
  const result=await managerOperationsBridge(action,argv[3],payload,f.options);if(afterFault?.(action,payload))throw Error('synthetic lost bridge stdout');
  return {exit_code:0,output:JSON.stringify(result),exit_code:0};
 },mcp__codex_app__send_message_to_thread:async r=>{
  sends++;assert.ok(r.prompt.endsWith(f.input.brief.text));assert.equal(r.threadId,'fake-w');
  if(native==='throw')throw Error('synthetic native loss');
  if(native==='missing')return {structuredContent:{threadId:r.threadId}};
  if(native==='denied')return {isError:true,structuredContent:{code:'POLICY_DENIED'}};
  if(native==='unknown')return {isError:false,structuredContent:{unexpected:true}};
  return {isError:false,structuredContent:{hostId:r.hostId,threadId:r.threadId}};
 }};
 return {tools,actions,get sends(){return sends;},run:(extra={})=>load()({...f.args,tools,...extra})};
}
for(const [team,mode] of [['synthetic-a','legacy'],['synthetic-b','observe'],['synthetic-c','queue_first']]){
 test('fixed entry '+team+'/'+mode+' complete, duplicate and concurrency',async t=>{
  const f=await setup(t,mode,team),h=harness(f);
  const first=await h.run();assert.equal(first.status,'recorded',JSON.stringify(first));assert.equal(h.sends,1);
  assert.equal((await h.run()).status,'recorded');assert.equal(h.sends,1);
  assert.equal((await f.raw()).tasks.length,1);assert.equal((await f.raw()).events.filter(e=>e.type==='startTask').length,1);
  const raw=JSON.parse(await readFile(f.input.hostEvidencePath,'utf8'));assert.equal(raw.outcome,'accepted');
  const f2=await setup(t,mode,team),h2=harness(f2);await Promise.all([h2.run(),h2.run(),h2.run()]);
  assert.equal(h2.sends,1);assert.equal((await f2.raw()).tasks.length,1);
 });
}
test('same operation changed content conflicts; malformed fields correct without new IDs',async t=>{
 const f=await setup(t),h=harness(f);
 const bad=structuredClone(f.input);bad.enqueueInput.required='wrong';
 assert.equal((await h.run({input:bad})).reasonCode,'INVALID_REQUEST');await assert.rejects(access(f.requestFile));
 const saved=await managerOperationsBridge('save',f.requestFile,{input:f.input},f.options);assert.equal(saved.status,'saved');
 const changed=structuredClone(f.input);changed.brief.text='different task content';
 assert.equal((await h.run({input:changed})).reasonCode,'OPERATION_CONFLICT');assert.equal(h.sends,0);
 assert.equal((await h.run()).status,'recorded');assert.equal(h.sends,1);
 assert.equal((await h.run({input:changed})).reasonCode,'OPERATION_CONFLICT');assert.equal(h.sends,1);
});
test('stale CAS correction stays same operation/task; after enqueue only admission correction',async t=>{
 const f=await setup(t),h=harness(f),bad=structuredClone(f.input);bad.enqueueInput.expectedVersion=0;
 const first=await h.run({input:bad});assert.equal(first.stages.prepare.stages.enqueue.reasonCode,'VERSION_CONFLICT');assert.equal((await f.raw()).tasks.length,0);
 assert.equal((await h.run({repairFingerprint:fingerprint(bad)})).status,'recorded');assert.equal(h.sends,1);
 const f2=await setup(t),wrong=structuredClone(f2.input);wrong.prepareInput.admission.native.thread_id='wrong-worker';
 const h2=harness(f2);await h2.run({input:wrong});assert.equal((await f2.raw()).tasks.length,1);assert.equal(h2.sends,0);
 assert.equal((await h2.run({repairFingerprint:fingerprint(wrong)})).status,'recorded');assert.equal((await f2.raw()).tasks.length,1);
});
for(const native of ['unknown','throw','missing','denied'])test(native+' result never guesses or resends',async t=>{
 const f=await setup(t),h=harness(f,{native});const first=await h.run();assert.equal(first.status,'recorded',JSON.stringify(first));
 assert.equal(first.stages.host.outcome,native==='denied'?'denied':'unknown');await h.run();assert.equal(h.sends,1);
});
test('result business write failure recovers saved raw evidence without send',async t=>{
 const f=await setup(t),h=harness(f);
 // E04 write hook affects only dispatch writes. Fail the result after native
 // return and after exact raw evidence has already been saved.
 let count=0;f.options.writeState=async(path,bytes)=>{count++;if(count===2)throw Error('synthetic result registration failure');await writeFile(path,bytes);};
 const first=await h.run();assert.equal(first.status,'reconcile',JSON.stringify(first));assert.equal(h.sends,1);await access(f.input.hostEvidencePath);
 delete f.options.writeState;
 assert.equal((await h.run()).status,'recorded');assert.equal(h.sends,1);assert.equal((await f.raw()).tasks.length,1);
});
for(const stop of ['entry_prepare','entry_result'])test('break before '+stop+' keeps single task and never resends',async t=>{
 const f=await setup(t);let once=true;const h=harness(f,{...(stop==='entry_prepare'?{afterFault:action=>action===stop&&once?(once=false,true):false}:{fault:action=>action===stop&&once?(once=false,true):false})});
 const first=await h.run();assert.equal(first.status,'reconcile');const n=h.sends;
 const second=await h.run();assert.equal(second.status,'reconcile');assert.equal(h.sends,n);assert.equal((await f.raw()).tasks.length,1);
 const status=await dispatchEntryStage('entry_status',f.requestFile,{},f.options);assert.equal(status.transport.prepared,true);
 assert.equal(status.transport.sendClaimed,true);
});
test('send claim is exclusive even when stdout is lost',async t=>{
 const f=await setup(t);await managerOperationsBridge('save',f.requestFile,{input:f.input},f.options);
 const p=await managerOperationsBridge('entry_prepare',f.requestFile,{},f.options),payload={inputFingerprint:p.inputFingerprint,attemptId:p.resultRequestBase.attempt_id};
 const claims=await Promise.all([managerOperationsBridge('claim_send',f.requestFile,payload,f.options),managerOperationsBridge('claim_send',f.requestFile,payload,f.options)]);
 assert.equal(claims.filter(r=>r.sendNow===true).length,0);assert.equal((await harness(f).run()).status,'reconcile');
});
for(const denial of ['busy','manager','binding','registry','authorization'])test(denial+' refusal preserves guards',async t=>{
 const f=await setup(t);
 if(denial==='busy'){const q=await f.enqueue({taskId:'occupied'});await f.dispatch(q);f.input.enqueueInput.expectedVersion=(await f.raw()).version;}
 if(denial==='manager'){f.input.enqueueInput.caller.threadId='not-manager';f.input.brief.actor.threadId='not-manager';}
 if(denial==='binding')f.input.prepareInput.admission.native.thread_id='wrong-worker';
 if(denial==='registry')f.options.exporter=async()=>{throw Error('synthetic registry refused');};
 const h=harness(f),r=await h.run(denial==='authorization'?{hostSendAuthorized:false}:{});
 assert.notEqual(r.status,'recorded');assert.equal(h.sends,0);assert.equal((await f.raw()).events.filter(e=>e.type==='startTask').length,denial==='busy'?1:0);
});
test('new entry cannot reinterpret rework/clarification as new task',async t=>{
 const f=await setup(t),h=harness(f);
 const retry=structuredClone(f.input);retry.prepareInput.retry_of_attempt_id='old-attempt';delete retry.prepareInput.baseline;
 assert.equal((await h.run({input:retry})).reasonCode,'INVALID_REQUEST');assert.equal((await f.raw()).tasks.length,0);assert.equal(h.sends,0);
});

test('same operation/task using different request paths cannot gain second send',async t=>{
 const f=await setup(t),h=harness(f),other=f.root+'/alternate.json';
 const results=await Promise.all([h.run(),h.run({requestFile:other})]);
 assert.equal(h.sends,1,JSON.stringify(results));assert.equal((await f.raw()).tasks.length,1);
 await h.run({requestFile:other});assert.equal(h.sends,1);
 // Copying the fresh prepared receipt cannot mint a second attempt claim.
 await writeFile(other+'.prepared.json',await readFile(f.requestFile+'.prepared.json','utf8').catch(()=>readFile(other+'.prepared.json','utf8')));
 const saved=JSON.parse(await readFile(other,'utf8')),prep=JSON.parse(await readFile(other+'.prepared.json','utf8'));
 const r=await managerOperationsBridge('claim_send',other,{inputFingerprint:fingerprint(saved),attemptId:prep.resultRequestBase.attempt_id},f.options);
 assert.notEqual(r.sendNow,true);assert.equal(h.sends,1);
});
test('lost enqueue reply and prepared receipt failure never duplicate task/attempt',async t=>{
 const f=await setup(t),h=harness(f);let once=true;f.options.fault=async where=>{if(where==='after-business'&&once){once=false;throw Error('lost enqueue reply');}};
 await h.run();assert.equal((await f.raw()).tasks.length,1);assert.equal(h.sends,0);
 delete f.options.fault;assert.equal((await h.run()).status,'recorded');assert.equal(h.sends,1);assert.equal((await f.raw()).tasks.length,1);
});

for(const point of ['after-prepare','after-claim','after-native-evidence'])test('explicit process interruption '+point,async t=>{
 const f=await setup(t),h=harness(f);f.options.entryFault=async at=>{if(at===point)throw Error('synthetic abrupt stop');};
 await h.run();delete f.options.entryFault;
 const status=await dispatchEntryStage('entry_status',f.requestFile,{},f.options);
 assert.equal(status.transport.prepared,true);assert.equal(status.transport.sendClaimed,point!=='after-prepare');
 const prior=h.sends,result=await h.run();assert.equal(h.sends,prior);
 if(point==='after-native-evidence')assert.equal(result.status,'recorded');
 else assert.equal(result.stages.result.reasonCode,point==='after-prepare'?'PREPARED_UNCLAIMED':'NATIVE_RESULT_UNKNOWN');
 assert.equal((await f.raw()).tasks.length,1);assert.equal((await f.raw()).events.filter(e=>e.type==='startTask').length,1);
});
test('different paths and different contents with same operation cannot start second task',async t=>{
 const f=await setup(t),h=harness(f),other=structuredClone(f.input);other.brief.text='changed original scope';
 await Promise.all([h.run(),h.run({requestFile:f.root+'/conflicting.json',input:other})]);
 assert.ok(h.sends<=1);await h.run();assert.equal(h.sends,1);assert.equal((await f.raw()).tasks.length,1);
});

test('cached prepare without send claim cannot regain permission via standalone action or template',async t=>{
 const f=await setup(t),h=harness(f);f.options.entryFault=async point=>{if(point==='after-prepare')throw Error('stop before claim');};
 await h.run();delete f.options.entryFault;
 const prepared=JSON.parse(await readFile(f.requestFile+'.prepared.json','utf8'));
 const r=await managerOperationsBridge('claim_send',f.requestFile,{attemptId:prepared.resultRequestBase.attempt_id,inputFingerprint:prepared.inputFingerprint},f.options);
 assert.equal(r.status,'error');assert.equal(r.sendNow,false);await h.run();assert.equal(h.sends,0);
 assert.equal((await dispatchEntryStage('entry_status',f.requestFile,{},f.options)).transport.sendClaimed,false);
 let calls=0,native=0;
 const tools={exec_command:async()=>({exit_code:0,output:JSON.stringify(++calls===1?{status:'prepared',sendNow:true,inputFingerprint:'a'.repeat(64),
  hostRequest:{tool:'mcp__codex_app__send_message_to_thread',arguments:{hostId:'h',threadId:'w',prompt:'cached'}},resultRequestBase:{attempt_id:'cached'}}:{})}),
  mcp__codex_app__send_message_to_thread:async()=>{native++;}};
 const result=await load()({...f.args,input:undefined,tools});assert.equal(result.status,'reconcile');assert.equal(native,0);assert.equal(calls,1);
});
