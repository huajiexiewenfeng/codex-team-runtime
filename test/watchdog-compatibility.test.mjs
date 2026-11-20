import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,appendFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {probeWatchdogLongSession,createWatchdogQueueProfile,verifyWatchdogQueueProfile,captureWatchdogIdleObservation} from '../src/watchdog-compatibility.mjs';import {prepareWatchdogReminder,readPreparedWatchdogReminder,reconcileWatchdogReminder} from '../src/watchdog-receipts.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex'),thread='fixture-long-thread',hostId='local';
const line=(type,payload,timestamp)=>JSON.stringify({type,payload,timestamp})+'\n';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'watchdog-compat-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'long.jsonl'),ledgerPath=join(dir,'receipts.json'),profilePath=join(dir,'profile.json'),binary=join(dir,'fixture-client');await writeFile(binary,'fixture client bytes');await writeFile(path,line('session_meta',{id:thread,cli_version:'0.153.4',source:'vscode'},'2026-01-01T00:00:00.000Z'));
 const log={path,hostId,threadId:thread,hostLogVersion:'0.153.4',queueClientVersion:'fixture-client'},context={teamId:'compat-fixture',taskId:'new-test',executionId:'new-test-execution',sourceVersion:0,sourceUpdatedAt:'2026-11-16T08:00:00.000Z',hostId,threadId:thread},current={teamId:context.teamId,taskId:context.taskId,executionId:context.executionId,sourceVersion:0,hostId,threadId:thread},client={path:binary,sha256:sha(await readFile(binary)),version:'fixture-client'};
 return {dir,path,log,ledgerPath,profilePath,context,current,client};}
async function events(f,text,trigger='queue',turn='new-controlled-turn'){
 const start='2026-11-16T08:01:00.000Z',end='2026-11-16T08:01:03.000Z',seconds=Date.parse(start)/1000;
 await appendFile(f.path,line('event_msg',{type:'task_started',turn_id:turn,started_at:seconds,turn_attribution:{turn_id:turn,turn_trigger:trigger}},start)+line('response_item',{type:'message',role:'user',content:[{type:'input_text',text}],internal_chat_message_metadata_passthrough:{turn_id:turn,create_time:seconds+1,content_item_kinds:['user.text'],content_item_metadata:[{provenance:{type:'user'}}]}},'2026-11-16T08:01:01.000Z')+line('event_msg',{type:'task_complete',turn_id:turn,started_at:seconds,completed_at:seconds+3},end));
}
const at='2026-11-16T08:05:00.000Z',runner=async()=>({stdout:'codex-cli fixture-client'});
async function prepare(f){return prepareWatchdogReminder({ledgerPath:f.ledgerPath,context:f.context,log:f.log,at:f.context.sourceUpdatedAt});}
test('old creation metadata is preserved; bounded actual modern lifecycle only proves schema, not queue or idle',async t=>{
 const f=await fixture(t);await events(f,'arbitrary existing user text','app_tool_send_message');const p=await probeWatchdogLongSession({...f.log,at});assert.equal(p.sessionCreatedVersion,'0.153.4');assert.equal(p.structureStatus,'compatible-native-metadata-observed');assert.equal(p.queueCompatibility,'unverified-until-new-controlled-probe');assert.equal(p.hostIdle,'unknown-native-observation-required');assert.equal(p.fullPrefixHashed,false);assert.equal(JSON.stringify(p).includes('arbitrary existing user text'),false);
});
test('missing lifecycle / wrong exact thread / future tail fail closed without fake profile',async t=>{
 const f=await fixture(t);assert.equal((await probeWatchdogLongSession({...f.log,at})).structureStatus,'unknown');await assert.rejects(probeWatchdogLongSession({...f.log,threadId:'wrong',at}),/thread/);await appendFile(f.path,line('event_msg',{type:'unknown'},'2026-11-16T09:00:00.000Z'));await assert.rejects(probeWatchdogLongSession({...f.log,at}),/Future/);
});
test('computed profile requires new unique queued turn completion; ordinary user turn cannot certify',async t=>{
 const f=await fixture(t),p=await prepare(f),out=await readPreparedWatchdogReminder(f.ledgerPath,p.attemptId);await events(f,out.text,'app_tool_send_message');await assert.rejects(createWatchdogQueueProfile({...f,attemptId:p.attemptId,at},{runner}),/completion/);
});
test('fixed capability profile rejects drift while evolving receipt still detects later duplicates',async t=>{
 const f=await fixture(t),p=await prepare(f),out=await readPreparedWatchdogReminder(f.ledgerPath,p.attemptId);await events(f,out.text);const profile=await createWatchdogQueueProfile({...f,attemptId:p.attemptId,at},{runner});assert.equal(profile.log.hostLogVersion,'0.153.4');assert.equal(JSON.stringify(profile).includes(out.text),false);
 const v=await verifyWatchdogQueueProfile({...f,at});assert.equal(v.actualNativeQueueEvidence,true);await assert.rejects(verifyWatchdogQueueProfile({...f,client:{...f.client,version:'different'},at}),/client/);
 const original=await readFile(f.profilePath,'utf8'),forged=JSON.parse(original);forged.safe=true;await writeFile(f.profilePath,JSON.stringify(forged));await assert.rejects(verifyWatchdogQueueProfile({...f,at}),/closed/);await writeFile(f.profilePath,original);
 await events(f,out.text,'queue','duplicate-controlled-turn');assert.equal((await verifyWatchdogQueueProfile({...f,at})).historicalFixedProof,true);assert.equal((await reconcileWatchdogReminder({ledgerPath:f.ledgerPath,attemptId:p.attemptId,current:f.current,at})).receiptStatus,'unknown');
});
test('profile proof range cannot be changed or copied to another log',async t=>{
 const f=await fixture(t),p=await prepare(f),out=await readPreparedWatchdogReminder(f.ledgerPath,p.attemptId);await events(f,out.text);await createWatchdogQueueProfile({...f,attemptId:p.attemptId,at},{runner});const obj=JSON.parse(await readFile(f.profilePath,'utf8'));obj.evidence.userLine++;const {profileId,...body}=obj;obj.profileId=sha(JSON.stringify(body));await writeFile(f.profilePath,JSON.stringify(obj));await assert.rejects(verifyWatchdogQueueProfile({...f,at}),/range/);
});
test('idle observation comes from exact native tool poll and agrees with log; no handwritten safe approval',async t=>{
 const f=await fixture(t);await events(f,'preexisting metadata witness','app_tool_send_message');const toolResult={polls:[{thread:{id:thread,hostId,status:{type:'idle'}},latestTurn:{id:'new-controlled-turn',status:'completed'}}]},path=join(f.dir,'idle.json');const idle=await captureWatchdogIdleObservation({toolResult,log:f.log,path,at});assert.equal(idle.latestTurnId,'new-controlled-turn');assert.equal(idle.toolResultSha256,sha(JSON.stringify(toolResult)));assert.equal(idle.safe,undefined);await assert.rejects(captureWatchdogIdleObservation({toolResult:{safe:true},log:f.log,path:join(f.dir,'fake.json'),at}),/poll/);
});

test('future append beyond 8MiB does not erase fixed capability proof; evolving reminder receipt remains unknown',async t=>{
 const f=await fixture(t),p=await prepare(f),out=await readPreparedWatchdogReminder(f.ledgerPath,p.attemptId);await events(f,out.text);await createWatchdogQueueProfile({...f,attemptId:p.attemptId,at},{runner});
 await appendFile(f.path,line('event_msg',{type:'opaque-future',text:'x'.repeat(1024)},'2026-11-16T08:06:00.000Z').repeat(9000));
 const verified=await verifyWatchdogQueueProfile({...f,at:'2026-11-16T08:07:00.000Z'});assert.equal(verified.historicalFixedProof,true);
 const receipt=await reconcileWatchdogReminder({ledgerPath:f.ledgerPath,attemptId:p.attemptId,current:f.current,at:'2026-11-16T08:07:00.000Z'});assert.equal(receipt.receiptStatus,'unknown');assert.equal(receipt.reason,'log-append-boundary-exceeded');
});
