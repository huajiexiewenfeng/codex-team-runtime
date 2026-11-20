import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createState,evolve} from '../src/runtime.mjs';
import {fixtureWatchdogDeployment,loadWatchdogDeployment,testedLocalQueuePair} from '../src/watchdog-deployment.mjs';
import {checkWatchdog,configureWatchdog,watchdogStatus} from '../src/watchdog-runtime.mjs';
const thread='00000000-0000-4000-8000-000000000001';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wd-auto-'));t.after(()=>rm(dir,{recursive:true,force:true}));const statePath=join(dir,'state.json'),logPath=join(dir,'native.jsonl'),base=Date.now();
 const member=(id,role)=>({id,role,name:id,lifecycle:'active',binding:{status:'bound',hostId:'local',threadId:role==='Manager'?thread:id+'-thread'}}),source={kind:'fixture',ref:'offline-auto'};
 let state=createState({teamId:'auto-fixture',name:'fixture',source,members:[member('manager','Manager'),member('liaison','Liaison'),member('worker','Worker')]},new Date(base-3*3600000).toISOString());
 const apply=(type,data={},actor='manager',at=base-2*3600000)=>{state=evolve(state,{id:'event-'+(state.version+1),type,actor,source,at:new Date(at).toISOString(),...data},state.version);return state;};
 apply('openRound',{roundId:'round',title:'fixture'});apply('assign',{roundId:'round',taskId:'task',title:'fixture task',workerId:'worker',required:true,assignedAt:new Date(base-2*3600000).toISOString()});await writeFile(statePath,JSON.stringify(state));
 const line=(type,payload,at)=>JSON.stringify({type,payload,timestamp:new Date(at).toISOString()})+'\n';await writeFile(logPath,line('session_meta',{id:thread,cli_version:'fixture-host',source:'vscode'},base-86400000));
 const config={statePath,teamId:'auto-fixture',manager:{hostId:'local',threadId:thread},binary:{path:'fixture-only-no-executable',sha256:'fixture',version:'fixture-client'},log:{path:logPath,hostId:'local',threadId:thread,hostLogVersion:'fixture-host',queueClientVersion:'fixture-client'}};
 let sends=0,verifications=0,lastText=null;
 async function appendNative(text,turn='native-reminder'){
  const n=Date.now(),sec=Math.floor(n/1000);
  await appendFile(logPath,line('event_msg',{type:'task_started',turn_id:turn,started_at:sec,turn_attribution:{turn_id:turn,turn_trigger:'queue'}},n)+line('response_item',{type:'message',role:'user',content:[{type:'input_text',text}],internal_chat_message_metadata_passthrough:{turn_id:turn,create_time:n/1000,content_item_kinds:['user.text'],content_item_metadata:[{provenance:{type:'user'}}]}},n)+line('event_msg',{type:'task_complete',turn_id:turn,started_at:sec,completed_at:sec},n));
 }
 const runner=async(_binary,args,options)=>{assert.equal(options.shell,false);assert.deepEqual(args.slice(0,3),['queue','--thread',thread]);assert.equal(args.includes('--resume'),false);sends++;lastText=args[4];await appendNative(lastText);return {stdout:`Queued message 00000000-0000-4000-8000-000000000002 for thread ${thread}.\n`,stderr:''};};
 const deployment=fixtureWatchdogDeployment(config,{runner,verify:async()=>{verifications++;}});
 const submit=async()=>{apply('submit',{roundId:'round',taskId:'task',summary:'fixture submission'},'worker',base-31*60000);await writeFile(statePath,JSON.stringify(state));};
 const approve=async()=>{apply('review',{roundId:'round',taskId:'task'},'manager',base+5000);apply('approve',{roundId:'round',taskId:'task',summary:'fixture only',evidence:['fixture']},'manager',base+5001);await writeFile(statePath,JSON.stringify(state));};
 const check=(extra={})=>checkWatchdog(statePath,{at:new Date().toISOString(),deployment,...extra});
 return {dir,statePath,logPath,config,base,source,apply,submit,approve,check,appendNative,deployment,runner,get state(){return state;},get sends(){return sends;},get verifications(){return verifications;},get lastText(){return lastText;}};
}
test('automatic no-anomaly -> queue -> native receipt -> repeat -> off -> restart -> business approved sleep',async t=>{
 const f=await fixture(t);let s=await f.check();assert.equal(s.attempts.length,0);assert.equal(f.sends,0);assert.equal(f.verifications,0);
 await f.submit();s=await f.check();assert.equal(f.sends,1);assert.equal(s.attempts[0].outcome,'queued');assert.ok(s.attempts[0].receiptAttemptId);assert.equal(JSON.parse(f.lastText).kind,'reminder');assert.equal(JSON.parse(f.lastText).body.includes('No business work is authorized'),false);
 s=await f.check();assert.equal(s.attempts[0].outcome,'completed');assert.equal(s.anomalies[0].active,true);assert.equal(s.counters.confirmedDelivery,1);assert.equal(s.counters.completedReminderTurns,1);
 const verified=f.verifications;s=await f.check();assert.equal(f.verifications,verified);assert.equal(f.sends,1);assert.equal(s.counters.completedReminderTurns,1);
 await configureWatchdog(f.statePath,false);await f.check();assert.equal(f.verifications,verified);assert.equal(f.sends,1);await configureWatchdog(f.statePath,true);
 const restart=fixtureWatchdogDeployment(structuredClone(f.config),{runner:f.runner});s=await f.check({deployment:restart});assert.equal(f.sends,1);assert.equal(s.attempts[0].outcome,'completed');
 await f.approve();s=await f.check({at:new Date(f.base+6000).toISOString()});assert.equal(s.phase,'sleeping');assert.equal(s.anomalies[0].active,false);
});
test('later duplicate native full text downgrades deployment receipt, does not resend or resolve business',async t=>{
 const f=await fixture(t);await f.submit();await f.check();await f.check();await f.appendNative(f.lastText,'duplicate-native-turn');const r=await f.check();assert.equal(r.attempts[0].outcome,'unknown');assert.equal(f.sends,1);assert.equal(r.anomalies[0].active,true);
});
test('legacy unresolved attempts remain unknown without fabricated receipt IDs',async t=>{
 const f=await fixture(t);await f.submit();await f.check({deployment:null});const path=f.statePath+'.watchdog/state.json',s=JSON.parse(await readFile(path,'utf8')),key=s.anomalies[0].key;
 s.attempts=[{id:'a'.repeat(64),at:new Date(f.base-1000).toISOString(),keys:[key],outcome:'unknown'}];s.anomalies[0].delivery='unknown';await writeFile(path,JSON.stringify(s));const r=await f.check();assert.equal(r.attempts[0].outcome,'unknown');assert.equal(r.attempts[0].receiptAttemptId,undefined);assert.equal(f.sends,0);
});
test('explicit off, no manifest, target rebind, or version/hash drift never queues',async t=>{
 const f=await fixture(t);await f.submit();await f.check({deployment:null});assert.equal(f.sends,0);await configureWatchdog(f.statePath,false);await f.check();assert.equal(f.verifications,0);await configureWatchdog(f.statePath,true);
 const changed=structuredClone(f.state);changed.members.find(m=>m.role==='Manager').binding.threadId='new-manager';await writeFile(f.statePath,JSON.stringify(changed));assert.equal((await f.check()).phase,'fault');assert.equal(f.sends,0);
});
test('fresh guard denial before marker is known not-sent and keeps anomaly pending',async t=>{
 const f=await fixture(t);await f.submit();let n=0;const adapter=fixtureWatchdogDeployment(structuredClone(f.config),{runner:f.runner,verify:async()=>{if(++n===2){const changed=structuredClone(f.state);changed.team.name='source changed before send';await writeFile(f.statePath,JSON.stringify(changed));}}});
 const r=await f.check({deployment:adapter});assert.equal(f.sends,0);assert.equal(r.attempts[0].outcome,'not-sent');assert.equal(r.anomalies[0].delivery,'pending');
});
test('manifest cannot self-assert safe, register another host or untested binary pair',async t=>{
 const f=await fixture(t),manifestPath=join(f.dir,'deployment.json');
 const row={statePath:f.statePath,teamId:f.state.team.id,manager:{hostId:'local',threadId:thread},binary:{path:process.execPath,sha256:testedLocalQueuePair.binarySha256,version:testedLocalQueuePair.clientVersion},log:{path:f.logPath,hostId:'local',threadId:thread,hostLogVersion:testedLocalQueuePair.hostLogVersion,queueClientVersion:testedLocalQueuePair.clientVersion}};
 for(const change of [r=>r.safe=true,r=>r.manager.hostId='remote',r=>r.binary.sha256='fake']){const r=structuredClone(row);change(r);await writeFile(manifestPath,JSON.stringify({schemaVersion:1,kind:'watchdog-local-queue-deployment',teams:[r]}));await assert.rejects(loadWatchdogDeployment(manifestPath));}
 await writeFile(manifestPath,JSON.stringify({schemaVersion:1,kind:'watchdog-local-queue-deployment',teams:[row]}));const d=await loadWatchdogDeployment(manifestPath);await f.submit();const result=await f.check({deployment:d.adapterFor(f.statePath)});assert.equal(result.phase,'fault');assert.equal(f.sends,0);
});
import {prepareWatchdogReminder} from '../src/watchdog-receipts.mjs';
test('pre-marker prepare validation failure is known not-sent, faulted and recoverable pending',async t=>{
 const f=await fixture(t);await f.submit();const bad=fixtureWatchdogDeployment(structuredClone(f.config),{runner:f.runner,verify:async()=>{throw new Error('binary drift');}});
 const first=await f.check({deployment:bad});assert.equal(first.phase,'fault');assert.equal(first.attempts[0].outcome,'not-sent');assert.equal(first.anomalies[0].delivery,'pending');assert.equal(f.sends,0);
 const recovered=await f.check();assert.equal(recovered.attempts.at(-1).outcome,'queued');assert.equal(f.sends,1);
});
test('receipt budget rotates so 21st unresolved intent is checked, never fixed-first-20 starvation',async t=>{
 const f=await fixture(t);await f.submit();await f.check({deployment:null});const storePath=f.statePath+'.watchdog/state.json',s=JSON.parse(await readFile(storePath,'utf8')),anomaly=s.anomalies[0];s.attempts=[];anomaly.delivery='unknown';
 for(let i=0;i<21;i++){
  const r=await prepareWatchdogReminder({ledgerPath:f.statePath+'.watchdog/reminder-receipts.json',context:{teamId:f.state.team.id,taskId:'task',executionId:anomaly.executionId,sourceVersion:f.state.version,sourceUpdatedAt:f.state.updatedAt,hostId:'local',threadId:thread},log:f.config.log,at:new Date(f.base-500).toISOString(),operationId:'fair-'+i});
  s.attempts.push({id:i.toString(16).padStart(64,'0'),at:new Date(f.base-500).toISOString(),keys:[anomaly.key],outcome:'unknown',receiptAttemptId:r.attemptId,taskId:'task',executionId:anomaly.executionId,receiptStatus:'unknown'});
 }
 await writeFile(storePath,JSON.stringify(s));let r=await f.check();assert.equal(r.attempts.filter(a=>a.lastReceiptCheckedAt).length,20);r=await f.check();assert.equal(r.attempts.filter(a=>a.lastReceiptCheckedAt).length,21);assert.equal(f.sends,0);
});
test('two pending tasks receive distinct receipt intents under shared cooldown without first-task starvation',async t=>{
 const f=await fixture(t);await f.submit();
 // Add a second valid historical/current Worker before assigning its task.
 const state=structuredClone(f.state),worker={id:'worker2',role:'Worker',name:'worker2',lifecycle:'active',binding:{status:'bound',hostId:'local',threadId:'worker2-thread'}};
 state.members.push(worker);state.rounds[0].members.push(structuredClone(worker));await writeFile(f.statePath,JSON.stringify(state));
 const at=f.base-31*60000,source=f.source;let next=evolve(state,{id:'second-assign',type:'assign',actor:'manager',at:new Date(at).toISOString(),source,roundId:'round',taskId:'second-task',title:'second',workerId:'worker2',required:true,assignedAt:new Date(at).toISOString()},state.version);
 next=evolve(next,{id:'second-submit',type:'submit',actor:'worker2',at:new Date(at+1).toISOString(),source,roundId:'round',taskId:'second-task',summary:'second'},next.version);await writeFile(f.statePath,JSON.stringify(next));
 let r=await f.check();assert.equal(f.sends,1);r=await f.check();assert.equal(f.sends,1);assert.equal(r.anomalies.filter(a=>a.active).length,2);
 r=await f.check({at:new Date(Date.now()+16*60000).toISOString()});assert.equal(f.sends,2);assert.equal(new Set(r.attempts.filter(a=>a.receiptAttemptId).map(a=>a.taskId)).size,2);assert.equal(new Set(r.attempts.map(a=>a.receiptAttemptId)).size,2);
});
import {getUnchangedPreparedWatchdogSeal,checkPreparedWatchdogSeal} from '../src/watchdog-receipts.mjs';
test('fixture beforeSend pause sees persisted original receipt and completed baseline; fast guard precedes one queue',async t=>{
 const f=await fixture(t);await f.submit();let hooks=0,seen=null;const a=fixtureWatchdogDeployment(structuredClone(f.config),{runner:f.runner,beforeSend:async({ledgerPath,receiptAttemptId})=>{hooks++;seen=receiptAttemptId;const seal=await getUnchangedPreparedWatchdogSeal({ledgerPath,attemptId:receiptAttemptId});return async()=>{const check=await checkPreparedWatchdogSeal({ledgerPath,attemptId:receiptAttemptId,seal});assert.equal(check.prefixRehashed,false);return true;};}});
 const r=await f.check({deployment:a});assert.equal(hooks,1);assert.equal(f.sends,1);assert.equal(r.attempts[0].receiptAttemptId,seen);assert.equal(r.attempts[0].outcome,'queued');
});
test('cancelled fresh-idle hook stops before marker without sending or losing pending anomaly',async t=>{
 const f=await fixture(t);await f.submit();const controller=new AbortController();const a=fixtureWatchdogDeployment(structuredClone(f.config),{runner:f.runner,signal:controller.signal,beforeSend:async()=>{controller.abort();controller.signal.throwIfAborted();}});const r=await f.check({deployment:a});assert.equal(f.sends,0);assert.equal(r.attempts[0].outcome,'not-sent');assert.equal(r.anomalies[0].delivery,'pending');
});
test('reconcile-only mode cannot create a new attempt or call a sender even for fresh pending anomalies',async t=>{
 const f=await fixture(t);await f.submit();const before=await f.check({deliveryMode:'reconcile-only'});assert.equal(before.anomalies.length,1);assert.equal(before.attempts.length,0);assert.equal(f.sends,0);assert.equal(f.verifications,0);
 const sent=await f.check();assert.equal(sent.attempts.length,1);const receipt=await f.check({deliveryMode:'reconcile-only'});assert.equal(receipt.attempts.length,1);assert.equal(receipt.attempts[0].outcome,'completed');assert.equal(f.sends,1);
});
