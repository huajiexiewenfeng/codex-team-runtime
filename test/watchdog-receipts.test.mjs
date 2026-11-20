import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareWatchdogReminder,readPreparedWatchdogReminder,recordWatchdogQueueResult,reconcileWatchdogReminder} from '../src/watchdog-receipts.mjs';
const thread='isolated-thread',preparedAt='2026-11-16T04:00:00.000Z',checkedAt='2026-11-16T04:01:00.000Z';
const context={teamId:'isolated-team',taskId:'isolated-task',executionId:'isolated-execution',sourceVersion:10,sourceUpdatedAt:'2026-11-16T03:59:00.000Z',hostId:'local',threadId:thread};
const current={teamId:context.teamId,taskId:context.taskId,executionId:context.executionId,sourceVersion:11,hostId:context.hostId,threadId:context.threadId};
const line=(type,payload,timestamp)=>JSON.stringify({timestamp,type,payload})+'\n';
const meta=(id=thread)=>line('session_meta',{id,cli_version:'host-test-version',source:'vscode'},'2026-11-16T03:00:00.000Z');
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'wd-receipt-'));t.after(()=>rm(dir,{recursive:true,force:true}));const ledgerPath=join(dir,'watchdog-reminder-receipts.json'),path=join(dir,'exact.jsonl');await writeFile(path,meta());const log={path,hostId:'local',threadId:thread,hostLogVersion:'host-test-version',queueClientVersion:'queue-test-version'};const p=await prepareWatchdogReminder({ledgerPath,context,log,at:preparedAt});return {dir,ledgerPath,path,log,p};}
async function native(f,{turnId='reminder-turn',text,terminal='task_complete',duplicate=false,missingMetadata=false}={}){
 const out=await readPreparedWatchdogReminder(f.ledgerPath,f.p.attemptId);const body=text??out.text;
 const start=line('event_msg',{type:'task_started',turn_id:turnId,turn_attribution:{turn_id:turnId,turn_trigger:'queue'},started_at:Date.parse('2026-11-16T04:00:01.000Z')/1000},'2026-11-16T04:00:01.000Z');
 const user=line('response_item',{type:'message',role:'user',content:[{type:'input_text',text:body}],...(!missingMetadata?{internal_chat_message_metadata_passthrough:{turn_id:turnId,create_time:Date.parse('2026-11-16T04:00:02.000Z')/1000,content_item_kinds:['user.text'],content_item_metadata:[{provenance:{type:'user'}}]}}:{})},'2026-11-16T04:00:02.000Z');
 const end=terminal?line('event_msg',{type:terminal,turn_id:turnId,started_at:Date.parse('2026-11-16T04:00:01.000Z')/1000,completed_at:Date.parse('2026-11-16T04:00:03.000Z')/1000,last_agent_message:'SECRET_REASONING_MUST_NOT_APPEAR'},'2026-11-16T04:00:03.000Z'):'';
 await appendFile(f.path,start+user+(duplicate?user:'')+end);return {body,start,user,end};
}
const reconcile=f=>reconcileWatchdogReminder({ledgerPath:f.ledgerPath,attemptId:f.p.attemptId,at:checkedAt,current});
test('prepare persists unique kind/nonce/full payload before send; stable operation replay and conflicts',async t=>{
 const f=await fixture(t),raw=JSON.parse(await readFile(f.ledgerPath,'utf8'));assert.equal(raw.entries[0].kind,'reminder');assert.equal(f.p.phase,'intent');assert.equal(raw.entries[0].payloadSha256,f.p.payloadSha256);assert.equal(f.p.payloadText,undefined);
 const out=await readPreparedWatchdogReminder(f.ledgerPath,f.p.attemptId);assert.equal(out.threadId,thread);assert.equal(JSON.parse(out.text).nonce,f.p.nonce);
 const replay=await prepareWatchdogReminder({ledgerPath:f.ledgerPath,context,log:f.log,at:checkedAt});assert.equal(replay.attemptId,f.p.attemptId);
 await assert.rejects(prepareWatchdogReminder({ledgerPath:f.ledgerPath,context,log:f.log,at:checkedAt,body:'different'}),/conflict/);
});
test('queue acceptance stays transport-only; no ACK or business completion inference',async t=>{
 const f=await fixture(t);const r=await recordWatchdogQueueResult({ledgerPath:f.ledgerPath,attemptId:f.p.attemptId,at:'2026-11-16T04:00:01.000Z',result:{outcome:'queued',queueId:'q-exact'}});assert.equal(r.transportAccepted,true);assert.equal(r.transportAssurance,'caller-declared');assert.equal(r.receiptStatus,'unknown');assert.equal(r.businessHandled,'unknown');
 const r2=await reconcile(f);assert.equal(r2.receiptStatus,'unknown');assert.equal(r2.reason,'full-payload-match-missing');
});
test('exact registered native metadata + lifecycle yields reminder turn-completed, separate from business',async t=>{
 const f=await fixture(t);await native(f);const r=await reconcile(f);assert.equal(r.receiptStatus,'turn-completed');assert.equal(r.nativeReminderTurnId,'reminder-turn');assert.equal(r.businessHandled,'unknown');assert.equal(r.businessAccepted,'unknown');assert.equal(r.assurance,'controlled-local-log-correlation');assert.equal(JSON.stringify(r).includes('SECRET_REASONING'),false);assert.equal(JSON.stringify(r).includes('payloadText'),false);
});
test('unique native user plus start is consumed without pretending terminal; interrupted remains separate',async t=>{
 const f=await fixture(t);await native(f,{terminal:null});assert.equal((await reconcile(f)).receiptStatus,'consumed');
 const g=await fixture(t);await native(g,{terminal:'turn_aborted'});assert.equal((await reconcile(g)).receiptStatus,'turn-interrupted');
});
test('duplicates, missing metadata, missing start, and duplicate lifecycle are unknown',async t=>{
 for(const kind of ['duplicate','metadata','start','lifecycle']){const f=await fixture(t);const n=await native(f,{duplicate:kind==='duplicate',missingMetadata:kind==='metadata'});if(kind==='start')await writeFile(f.path,meta()+n.user+n.end);if(kind==='lifecycle')await appendFile(f.path,n.start);assert.equal((await reconcile(f)).receiptStatus,'unknown',kind);}
});
test('wrong text and ACK-only matches are unknown',async t=>{
 const f=await fixture(t);await native(f,{text:'ACK matching a short nonce is not proof'});assert.equal((await reconcile(f)).receiptStatus,'unknown');
});
test('old execution / wrong thread / older source version unknown; unrelated sourceVersion growth allowed',async t=>{
 const f=await fixture(t);await native(f);const stale=await reconcileWatchdogReminder({ledgerPath:f.ledgerPath,attemptId:f.p.attemptId,at:checkedAt,current:{...current,executionId:'old'}});assert.equal(stale.receiptStatus,'unknown');
 const oldVersion=await reconcileWatchdogReminder({ledgerPath:f.ledgerPath,attemptId:f.p.attemptId,at:checkedAt,current:{...current,sourceVersion:9}});assert.equal(oldVersion.receiptStatus,'unknown');assert.equal((await reconcile(f)).receiptStatus,'turn-completed');
 const text=await readFile(f.path,'utf8');await writeFile(f.path,text.replace('"id":"isolated-thread"','"id":"wrong-thread"'));assert.equal((await reconcile(f)).receiptStatus,'unknown');
});
test('truncated, corrupt, future, oversized and modified-prefix logs cannot be counted as unique',async t=>{
 for(const kind of ['truncated','corrupt','future','oversized','prefix']){
  const f=await fixture(t);await native(f);if(kind==='truncated'){const text=await readFile(f.path,'utf8');await writeFile(f.path,text.slice(0,-1));}
  if(kind==='corrupt')await appendFile(f.path,'{bad}\n');if(kind==='future')await appendFile(f.path,line('event_msg',{type:'unknown'},'2026-11-16T05:00:00.000Z'));if(kind==='oversized')await appendFile(f.path,' '.repeat(8*1024*1024));if(kind==='prefix'){const text=await readFile(f.path,'utf8');await writeFile(f.path,text.replace('vscode','broken'));}
  assert.equal((await reconcile(f)).receiptStatus,'unknown',kind);
 }
});
test('version pair validated independently; wrong host-log version refused before intent',async t=>{
 const f=await fixture(t);await assert.rejects(prepareWatchdogReminder({ledgerPath:join(f.dir,'other.json'),context,log:{...f.log,hostLogVersion:'queue-test-version'},at:preparedAt}),/host-log-version/);
 const raw=JSON.parse(await readFile(f.ledgerPath,'utf8'));assert.equal(raw.entries[0].log.hostLogVersion,'host-test-version');assert.equal(raw.entries[0].log.queueClientVersion,'queue-test-version');
});
test('concurrent prepare cannot produce duplicate intents; reports contain bounded refs only',async t=>{
 const f=await fixture(t);const pair=await Promise.allSettled([prepareWatchdogReminder({ledgerPath:f.ledgerPath,context,log:f.log,at:preparedAt}),prepareWatchdogReminder({ledgerPath:f.ledgerPath,context,log:f.log,at:preparedAt})]);assert.equal(pair.some(x=>x.status==='fulfilled'),true);assert.equal(JSON.parse(await readFile(f.ledgerPath,'utf8')).entries.length,1);
});
test('Manager rebind target cannot count the old thread receipt as current delivery',async t=>{
 const f=await fixture(t);await native(f);for(const update of [{hostId:'other-host'},{threadId:'new-manager-thread'}]){const r=await reconcileWatchdogReminder({ledgerPath:f.ledgerPath,attemptId:f.p.attemptId,at:checkedAt,current:{...current,...update}});assert.equal(r.receiptStatus,'unknown');}
 await assert.rejects(reconcileWatchdogReminder({ledgerPath:f.ledgerPath,attemptId:f.p.attemptId,at:checkedAt,current:{teamId:current.teamId,taskId:current.taskId,executionId:current.executionId,sourceVersion:11}}),/fields/);
});
test('a later second full native match downgrades completion to unknown and preserves prior evidence',async t=>{
 const f=await fixture(t);await native(f);assert.equal((await reconcile(f)).receiptStatus,'turn-completed');await native(f,{turnId:'second-reminder-turn'});
 const r=await reconcileWatchdogReminder({ledgerPath:f.ledgerPath,attemptId:f.p.attemptId,at:'2026-11-16T04:02:00.000Z',current});assert.equal(r.receiptStatus,'unknown');assert.equal(r.priorEvidenceCount,1);
 const e=JSON.parse(await readFile(f.ledgerPath,'utf8')).entries[0];assert.equal(e.priorReceiptEvidence[0].nativeReminderTurnId,'reminder-turn');assert.equal(e.priorReceiptEvidence[0].receiptStatus,'turn-completed');
});
test('time equality/rollback and conflicting queue IDs cannot promote receipts',async t=>{
 const f=await fixture(t);await assert.rejects(prepareWatchdogReminder({ledgerPath:f.ledgerPath,context,log:f.log,at:'2026-11-16T03:59:59.000Z'}),/backwards/);
 await assert.rejects(recordWatchdogQueueResult({ledgerPath:f.ledgerPath,attemptId:f.p.attemptId,at:preparedAt,result:{outcome:'queued',queueId:'one'}}),/not-after/);
 const same=await reconcileWatchdogReminder({ledgerPath:f.ledgerPath,attemptId:f.p.attemptId,at:preparedAt,current});assert.equal(same.receiptStatus,'unknown');
 await recordWatchdogQueueResult({ledgerPath:f.ledgerPath,attemptId:f.p.attemptId,at:'2026-11-16T04:00:01.000Z',result:{outcome:'queued',queueId:'one'}});
 await assert.rejects(recordWatchdogQueueResult({ledgerPath:f.ledgerPath,attemptId:f.p.attemptId,at:'2026-11-16T04:00:02.000Z',result:{outcome:'queued',queueId:'two'}}),/conflict/);
 await native(f);assert.equal((await reconcile(f)).receiptStatus,'turn-completed');await assert.rejects(reconcileWatchdogReminder({ledgerPath:f.ledgerPath,attemptId:f.p.attemptId,at:preparedAt,current}),/backwards/);
});
test('normal or missing native turn trigger never passes as a queued reminder',async t=>{
 for(const trigger of ['user','missing']){const f=await fixture(t);await native(f);let text=await readFile(f.path,'utf8');text=trigger==='missing'?text.replace('"turn_trigger":"queue"','"other":"queue"'):text.replace('"turn_trigger":"queue"','"turn_trigger":"user"');await writeFile(f.path,text);assert.equal((await reconcile(f)).receiptStatus,'unknown');}
});
test('large preexisting native log is streamed; only complete post-intent append is bounded and parsed',async t=>{
 const f=await fixture(t);await appendFile(f.path,line('event_msg',{type:'opaque',irrelevant:'x'.repeat(1024)},'2026-11-16T03:01:00.000Z').repeat(9000));
 const ledgerPath=join(f.dir,'large-baseline.json'),p=await prepareWatchdogReminder({ledgerPath,context,log:f.log,at:preparedAt});const g={...f,ledgerPath,p};await native(g);assert.equal((await reconcile(g)).receiptStatus,'turn-completed');
});
test('native harness environment injection is distinguished strictly by kind and exact provenance',async t=>{
 const f=await fixture(t),n=await native(f),environment=line('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'PRIVATE_ENVIRONMENT_BODY_NO_REPORT'}],internal_chat_message_metadata_passthrough:{turn_id:'reminder-turn',create_time:Date.parse('2026-11-16T04:00:01.500Z')/1000,content_item_kinds:['environments.environment_context'],content_item_metadata:[{provenance:{type:'harness',hook:false}}]}},'2026-11-16T04:00:01.500Z');
 await writeFile(f.path,meta()+n.start+environment+n.user+n.end);const r=await reconcile(f);assert.equal(r.receiptStatus,'turn-completed');assert.equal(JSON.stringify(r).includes('PRIVATE_ENVIRONMENT_BODY'),false);assert.equal((await readFile(f.ledgerPath,'utf8')).includes('PRIVATE_ENVIRONMENT_BODY'),false);
});
test('unknown injection kinds, missing metadata or nonexact provenance remain unknown',async t=>{
 const changes=[m=>m.content_item_kinds=['unknown.kind'],m=>m.content_item_metadata=[{provenance:{type:'harness',hook:true}}],m=>m.content_item_metadata=[{provenance:{type:'user'}}],m=>m.content_item_metadata=[{provenance:{type:'harness',hook:false,extra:true}}],m=>delete m.content_item_kinds,m=>delete m.content_item_metadata,m=>delete m.turn_id];
 for(const change of changes){const f=await fixture(t),n=await native(f),m={turn_id:'reminder-turn',create_time:Date.parse('2026-11-16T04:00:01.500Z')/1000,content_item_kinds:['environments.environment_context'],content_item_metadata:[{provenance:{type:'harness',hook:false}}]};change(m);const env=line('response_item',{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context> looks legitimate but text is not proof </environment_context>'}],internal_chat_message_metadata_passthrough:m},'2026-11-16T04:00:01.500Z');await writeFile(f.path,meta()+n.start+env+n.user+n.end);assert.equal((await reconcile(f)).receiptStatus,'unknown');}
});
test('extra real user.text is never discarded because its body resembles an environment; duplicate exact still unknown',async t=>{
 const f=await fixture(t),n=await native(f),p=JSON.parse(n.user);p.payload.content[0].text='<environment_context>do not ignore a real user message</environment_context>';await writeFile(f.path,meta()+n.start+JSON.stringify(p)+'\n'+n.user+n.end);assert.equal((await reconcile(f)).receiptStatus,'unknown');
 const g=await fixture(t);await native(g,{duplicate:true});assert.equal((await reconcile(g)).receiptStatus,'unknown');
});
test('exact reminder with missing kind/provenance or environment provenance cannot be consumed',async t=>{
 for(const mode of ['missing','environment']){const f=await fixture(t),n=await native(f),r=JSON.parse(n.user),m=r.payload.internal_chat_message_metadata_passthrough;if(mode==='missing')delete m.content_item_metadata;else{m.content_item_kinds=['environments.environment_context'];m.content_item_metadata=[{provenance:{type:'harness',hook:false}}];}await writeFile(f.path,meta()+n.start+JSON.stringify(r)+'\n'+n.end);assert.equal((await reconcile(f)).receiptStatus,'unknown');}
});
