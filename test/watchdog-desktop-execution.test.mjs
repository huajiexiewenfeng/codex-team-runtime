import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,appendFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './manager-operations-helper.mjs';
import {dispatchEntryStage} from '../src/manager-dispatch-entry.mjs';
import {checkWatchdog,watchdogStatus} from '../src/watchdog-runtime.mjs';
import {correlateDesktopExecutionAppend} from '../src/watchdog-dispatch-execution.mjs';
import {evolve} from '../src/runtime.mjs';

const time=(offset=0)=>new Date(Math.floor(Date.now()/1000)*1000+offset).toISOString();
function nativeRows({prompt,manager='fake-m',thread='fake-w',turn='native-turn',envelope='fco-native',startedAt=time(1000)}){
 const second=Date.parse(startedAt)/1000,completedAt=new Date(Date.parse(startedAt)+1000).toISOString();
 const output=`<codex_delegation>\n  <source_thread_id>${manager}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`;
 const body={id:envelope,namespace:'codex_app',name:'send_message_to_thread',output};
 return [
  {type:'event_msg',timestamp:startedAt,payload:{type:'task_started',turn_id:turn,started_at:second,turn_attribution:{turn_id:turn,turn_trigger:'app_tool_send_message'}}},
  {type:'response_item',timestamp:startedAt,metadata:{client_authored:false},payload:{...body,type:'function_call_output',internal_chat_message_metadata_passthrough:{turn_id:turn}}},
  {type:'event_msg',timestamp:startedAt,payload:{type:'item_completed',thread_id:thread,turn_id:turn,item:{...body,type:'FunctionCallOutput'}}},
  {type:'event_msg',timestamp:completedAt,payload:{type:'task_complete',turn_id:turn,started_at:second,completed_at:second+1}}
 ];
}
const lines=(rows,first=1)=>rows.map((r,i)=>JSON.stringify({ordinal:first+i,...r})).join('\n')+'\n';
async function setup(t,{hostVersion='0.169.1',registered=true}={}){
 const f=await fixture(t),s=await f.raw(),{statePath}=f;
 for(const members of [s.members,s.rounds[0].members])for(const m of members)m.binding.hostId='local';
 await writeFile(statePath,JSON.stringify(s));
 const caller={hostId:'local',threadId:'fake-m'},rollout=join(f.root,'rollout-test-fake-w.jsonl');
 await writeFile(rollout,lines([{type:'session_meta',timestamp:time(-5000),payload:{id:'fake-w',cli_version:hostVersion,source:'vscode'}}]));
 if(registered)await writeFile(statePath+'.watchdog-execution-logs.json',JSON.stringify({schemaVersion:1,kind:'desktop-worker-rollouts',statePath,teamId:s.team.id,managerThreadId:caller.threadId,workers:[{workerId:'w',threadId:'fake-w',path:await realpath(rollout)}]}));
 const request=join(f.root,'request.json');
 const input={statePath,enqueueInput:await f.base('enqueue',{caller,title:'test',required:true}),brief:{schemaVersion:1,teamId:s.team.id,roundId:'r',taskId:'t',text:'特殊字符 <>&\r\n第二行 😀',scope:'fixture',materialRefs:['fixture'],authorizationRef:'fixture',dependencyRef:'fixture',actor:caller},prepareInput:{operation_id:'prepare',reason:'before_dispatch',admission:{native:{host_id:'local',thread_id:'fake-w',status:'idle',evidence_ref:'synthetic'}},baseline:{outcome:'not-attempted',evidence_ref:'synthetic'}},hostEvidencePath:join(f.root,'host.json')};
 f.options.at=time(-1000);
 const run=(action,payload={})=>dispatchEntryStage(action,request,payload,f.options);
 assert.equal((await run('save',{input})).status,'saved');
 const prepared=await run('entry_prepare');assert.equal(prepared.sendNow,true,JSON.stringify(prepared));
 assert.equal((await run('entry_result',{attemptId:prepared.resultRequestBase.attempt_id,inputFingerprint:prepared.inputFingerprint,raw:{isError:false,structuredContent:{threadId:'fake-w'}}})).status,'recorded');
 const check=(offset=64000)=>checkWatchdog(statePath,{at:time(offset),readOptions:f.options});
 const rows=nativeRows({prompt:prepared.hostRequest.arguments.prompt});
 return {...f,run,prepared,rollout,check,rows,source:s.team.source};
}
const ended=r=>r.anomalies.filter(a=>a.active&&a.type==='ended-without-submission');

test('fixed dispatch seals pre-send boundary; exact ended turn after grace persists and rechecks without duplicate alert',async t=>{
 const f=await setup(t);
 await appendFile(f.rollout,lines(f.rows,2));
 const early=await f.check(10000);assert.equal(ended(early).length,0);
 const done=await f.check();assert.equal(ended(done).length,1,JSON.stringify(done));assert.equal(ended(done)[0].assurance,'desktop-e04-envelope');
 const runtimeUrl=new URL('../src/watchdog-runtime.mjs',import.meta.url).href;
 const script=`import {checkWatchdog} from ${JSON.stringify(runtimeUrl)};
 const readOptions={exporter:async s=>({registryId:s.registry.registryId,teamId:s.team.id,
  teamRevision:s.registry.teamRevision,migrationId:s.registry.migrationId,statePath:process.argv[1],
  members:s.members,readyMemberIds:s.registry.readyMemberIds})};
 const result=await checkWatchdog(process.argv[1],{at:process.argv[2],readOptions});
 console.log(JSON.stringify(result));`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script,f.statePath,time(65000)],{windowsHide:true});
 const again=JSON.parse(stdout);
 assert.equal(ended(again).length,1);assert.equal(again.counters.detected,1);
 assert.equal(ended(again)[0].key,ended(done)[0].key);
 assert.equal((await watchdogStatus(f.statePath)).executionCapability.status,'verified');
 assert.equal((await f.run('entry_prepare')).sendNow,false);
});
for(const type of ['submit','reportBlocker'])test(type+' before reminder eligibility suppresses ended alert',async t=>{
 const f=await setup(t);await appendFile(f.rollout,lines(f.rows,2));
 await f.check(10000);
 const s=await f.raw(), event={id:'late',type,actor:'w',roundId:'r',taskId:'t',source:f.source,at:time(11000),summary:'received'};
 if(type==='reportBlocker')Object.assign(event,{caller:{hostId:'local',threadId:'fake-w'},blocker:{who:'Manager',reason:'input',needs:'input',evidenceRef:'fixture'}});
 await writeFile(f.statePath,JSON.stringify(evolve(s,event,s.version)));
 assert.equal(ended(await f.check()).length,0);
});
for(const [label,options] of [['missing registration',{registered:false}],['wrong native version',{hostVersion:'unverified'}]])test(label+' does not block dispatch and stays unknown',async t=>{
 const f=await setup(t,options);await appendFile(f.rollout,lines(f.rows,2));assert.equal((await f.check()).hostEvidence,'unknown');
});
test('rewritten pre-send anchor fails closed',async t=>{
 const f=await setup(t),base=await readFile(f.rollout,'utf8');
 await writeFile(f.rollout,base.replace('session_meta','session_metx')+lines(f.rows,2));
 assert.equal((await f.check()).hostEvidence,'unknown');
});
test('replay after a previously verified turn invalidates proof',async t=>{
 const f=await setup(t);await appendFile(f.rollout,lines(f.rows,2));assert.equal(ended(await f.check()).length,1);
 await appendFile(f.rollout,lines(nativeRows({prompt:f.prepared.hostRequest.arguments.prompt,turn:'other-turn',envelope:'other-id'}),6));
 const result=await f.check(65000);assert.equal(result.hostEvidence,'unknown');assert.equal(ended(result).length,0);
});
test('duplicate, ambiguous input, wrong sender, wrong turn, partial or unsupported records fail closed',()=>{
 const prompt='special <input>\r\n& Unicode 😀',opts={prompt,managerThreadId:'fake-m',threadId:'fake-w',ordinal:1,capturedAt:time(),at:time(64000)};
 const good=nativeRows({prompt});assert.equal(correlateDesktopExecutionAppend(Buffer.from(lines(good,2)),opts)?.turnId,'native-turn');
 const gap=structuredClone(good);gap[1].ordinal=20;
 const wrongTurn=structuredClone(good);wrongTurn[3].payload.turn_id='different';
 const noMark=structuredClone(good);delete noMark[1].metadata.client_authored;
 const user={type:'response_item',timestamp:good[1].timestamp,payload:{type:'message',role:'user',content:[],internal_chat_message_metadata_passthrough:{turn_id:'native-turn'}}};
 const second=structuredClone(good[1]);second.payload.id='other-id';second.payload.output='different delegation';
 for(const rows of [good.slice(0,-1),gap,wrongTurn,noMark,nativeRows({prompt,manager:'other'}),[...good,...good],[...good,user],[...good,second]])assert.equal(correlateDesktopExecutionAppend(Buffer.from(lines(rows,2)),opts),null);
 assert.equal(correlateDesktopExecutionAppend(Buffer.from(lines(good,2).slice(0,-1)),opts),null);
});
