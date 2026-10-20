import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createState,evolve,snapshot} from '../src/runtime.mjs';
import {initialize,readState} from '../src/store.mjs';
import {workerRuntime} from '../src/worker-runtime.mjs';
import {render} from '../src/render.mjs';
import {progressSummary} from '../src/progress-summary.mjs';
import {runFixedSubmission as runRoutedSubmission} from '../src/host-submit-flow.mjs';
import {assessNativeSend} from '../src/host-submit-flow.mjs';
const runFixedSubmission = options => runRoutedSubmission({notificationMode:'legacy',...options});
const at='2026-09-07T10:00:00.000Z',caller={actor_host_id:'local',actor_thread_id:'worker',team_id:'test-team',reason:'manual'};
const evidence={taskId:'t',summary:'Changed code',files:['src/a.mjs'],verification:[{command:'node --test',outcome:'passed',evidenceRef:'test-log'}],artifacts:[{path:'bundle',sha256:'a'.repeat(64),verification:'matched',evidenceRef:'sha-log'}],gaps:['not deployed']};
const request={action:'submit',...caller,submission_id:'submit-1',submission:evidence};
function setup(){let s=createState({teamId:'test-team',name:'test',source:{kind:'fixture',ref:'test only'},members:[['m','Manager','manager'],['l','Liaison','liaison'],['w','Worker','worker']].map(([id,role,threadId])=>({id,role,name:role,lifecycle:'active',binding:{status:'bound',hostId:'local',threadId}}))},at);
 s=evolve(s,{id:'open',type:'openRound',actor:'m',at,source:s.team.source,roundId:'r',title:'round'},s.version);
 return evolve(s,{id:'assign',type:'assign',actor:'m',at,source:s.team.source,roundId:'r',taskId:'t',title:'task',workerId:'w',required:true,assignedAt:at},s.version);}
async function fixture(t,s=setup()){const d=await mkdtemp(join(tmpdir(),'worker-structured-'));t.after(()=>rm(d,{recursive:true,force:true}));const path=join(d,'state.json');await initialize(path,s);return {path,call:r=>workerRuntime({statePath:path,request:r,options:{at}})};}
test('structured submission persists evidence, replays and conflicts without writes; approval requires review',async t=>{const x=await fixture(t);assert.equal((await x.call(request)).status,'submitted');const bytes=await readFile(x.path,'utf8'),s=await readState(x.path);assert.deepEqual(s.events.at(-1).submission,evidence);assert.equal(s.tasks[0].status,'submitted');assert.equal((await x.call(request)).replayed,true);assert.equal((await x.call({...request,submission:{...evidence,summary:'changed'}})).reasonCode,'OPERATION_CONFLICT');assert.equal(await readFile(x.path,'utf8'),bytes);assert.throws(()=>evolve(s,{id:'approve',type:'approve',actor:'m',roundId:'r',taskId:'t',at,source:s.team.source,summary:'ok',evidence:['independent']},s.version),/Approval requires review/);});
test('field errors, wrong caller/owner, exited current or historical member preserve bytes',async t=>{for(const kind of ['field','caller','owner','exited','historical']){const s=setup();if(kind==='exited')s.members[2].lifecycle='exited';if(kind==='historical')s.rounds[0].members[2].lifecycle='exited';const x=await fixture(t,s),before=await readFile(x.path,'utf8');let r=structuredClone(request);if(kind==='field')r.submission.artifacts[0].sha256='bad';if(kind==='caller')r.actor_thread_id='manager';if(kind==='owner')r.submission.taskId='missing';const result=await x.call(r);assert.equal(result.status,'error');if(kind==='field'){assert.equal(result.field,'artifacts[0].sha256');assert.equal(result.example.length,64);}assert.equal(await readFile(x.path,'utf8'),before);}});
test('concurrent submissions serialize with one winner; loser retries same ID',async t=>{const x=await fixture(t);const results=await Promise.all([x.call(request),x.call(request)]);assert.equal(results.filter(r=>r.status==='submitted'&&!r.replayed).length,1);assert.equal((await x.call(request)).replayed,true);assert.equal((await readState(x.path)).tasks[0].submissions,1);});
test('Worker blocker does not change Manager state; read-only summary and dashboard use recorded evidence',async t=>{const x=await fixture(t);const block={action:'blocker',...caller,operation_id:'blocker-1',task_id:'t',blocker:{reason:'test failure',who:'operator',needs:'test credentials',evidenceRef:'error-log'}};assert.equal((await x.call(block)).status,'blocker-recorded');const before=await readFile(x.path,'utf8');const r=await x.call({action:'summary',...caller,actor_thread_id:'manager'});assert.equal(r.tasks[0].status,'executing');assert.equal(r.tasks[0].blocker.who,'operator');assert.equal(r.tasks[0].agentWork.status,'unknown');assert.equal(r.tasks[0].recentActivity.source.ref,'worker-structured:blocker-1');assert.equal(await readFile(x.path,'utf8'),before);const html=render(snapshot(await readState(x.path),at));assert.match(html,/简短进度摘要/);assert.match(html,/test credentials/);await x.call(request);assert.equal(progressSummary(await readState(x.path)).tasks[0].blocker,null);});
test('blocker scope expires on rework/approval but historical report remains',()=>{let s=setup();s=evolve(s,{id:'submit',type:'submit',actor:'w',roundId:'r',taskId:'t',at,source:s.team.source,summary:'ready'},s.version);s=evolve(s,{id:'review',type:'review',actor:'m',roundId:'r',taskId:'t',at,source:s.team.source},s.version);s=evolve(s,{id:'block',type:'reportBlocker',actor:'w',caller:{hostId:'local',threadId:'worker'},roundId:'r',taskId:'t',at,source:s.team.source,summary:'needs',blocker:{reason:'test failure',who:'m',needs:'review',evidenceRef:'ref'}},s.version);for(const type of ['rework','approve']){const next=evolve(s,{id:type,type,actor:'m',roundId:'r',taskId:'t',at,source:s.team.source,summary:'reviewed',...(type==='approve'?{evidence:['checked']}: {})},s.version);const summary=progressSummary(next).tasks[0];assert.equal(summary.blocker,null);assert.equal(summary.latestBlockerReport.id,'block');}});
test('fixed host flow distinguishes receipt and delivery; exceptions never roll back submit or resend',async()=>{for(const outcome of ['accepted','unknown','policy-denied']){let sends=0;const r=await runFixedSubmission({request,noticeOperationId:'notice',submit:async()=>({status:'submitted'}),prepare:async()=>({status:'ready_to_send',sendNow:true,attemptId:'attempt',hostRequest:{}}),send:async()=>{sends++;return {outcome};},assess:async raw=>({outcome:raw.outcome,evidence:{kind:'host-result',ref:'actual response',detail:JSON.stringify(raw)}}),record:async()=>({status:'recorded'})});assert.equal(sends,1);assert.equal(r.nextAction,{accepted:'await-manager-review',unknown:'reconcile-same-attempt-no-resend','policy-denied':'stop-policy-denied'}[outcome]);}
 for(const phase of ['prepare','send','record']){let sends=0;const r=await runFixedSubmission({request,noticeOperationId:'notice',submit:async()=>({status:'submitted'}),prepare:async()=>{if(phase==='prepare')throw Error('offline');return {status:'ready_to_send',sendNow:true,attemptId:'attempt',hostRequest:{}};},send:async()=>{sends++;if(phase==='send')throw Error('timeout');return {};},assess:async()=>({outcome:'unknown',evidence:{kind:'observation',ref:'ref',detail:'unknown'}}),record:async()=>{if(phase==='record')throw Error('disk');return {status:'recorded'};}});assert.equal(r.submission,'submitted');assert.equal(sends,phase==='prepare'?0:1);assert.notEqual(r.nextAction,'await-manager-review');}
 let sends=0;const replay=await runFixedSubmission({request,noticeOperationId:'notice',submit:async()=>({status:'submitted',replayed:true}),prepare:async()=>({status:'ready_to_send',sendNow:true,replayed:true}),send:async()=>{sends++;}});assert.equal(sends,0);assert.equal(replay.stage,'prepare');const invalid=await runFixedSubmission({request,noticeOperationId:'n'.repeat(128),submit:async()=>{throw Error('must not call');}});assert.equal(invalid.stage,'validate');});

test('invalid reason fails before commit; summary exact filter rejects missing task; Manager and Worker blockers coexist',async t=>{const x=await fixture(t);const before=await readFile(x.path,'utf8');const bad=await x.call({...request,reason:'before_submit'});assert.equal(bad.field,'reason');assert.equal(bad.example,'manual');assert.equal(await readFile(x.path,'utf8'),before);const filtered=await x.call({action:'summary',...caller,task_id:'t'});assert.equal(filtered.scope,'exact-task');assert.equal(filtered.tasks.length,1);assert.equal((await x.call({action:'summary',...caller,task_id:'missing'})).status,'error');let s=setup();s=evolve(s,{id:'block',type:'block',actor:'m',roundId:'r',taskId:'t',at,source:s.team.source,summary:'Manager pause'},s.version);s=evolve(s,{id:'report',type:'reportBlocker',actor:'w',caller:{hostId:'local',threadId:'worker'},roundId:'r',taskId:'t',at,source:s.team.source,summary:'Credentials',blocker:{reason:'missing credential',who:'operator',needs:'credential',evidenceRef:'log'}},s.version);const summary=progressSummary(s,'t').tasks[0];assert.equal(summary.blocker.reason,'missing credential');assert.equal(summary.managerBlocker.reason,'Manager pause');});

test('actual functions.exec template executes with mocked tools; strict native target mapping and bounded evidence',async()=>{
 const template=await readFile(new URL('../docs/optimization/functions-exec-submit-template.js',import.meta.url),'utf8');assert.doesNotMatch(template,/\bimport\s|readFile\s*\(/);
 const native=(threadId,extra={})=>({content:[{type:'text',text:JSON.stringify({threadId,...extra})}],isError:false});
 const target={hostId:'local',threadId:'manager'};
 assert.equal(assessNativeSend(native('manager'),target,'ref').outcome,'accepted');
 assert.equal(assessNativeSend(native('other'),target,'ref').outcome,'unknown');
 assert.equal(assessNativeSend(native('manager',{hostId:'foreign'}),target,'ref').outcome,'unknown');
 assert.equal(assessNativeSend(native('manager',{error:'failed'}),target,'ref').outcome,'unknown');
 assert.equal(assessNativeSend({...native('manager'),isError:true},target,'ref').outcome,'unknown');
 assert.equal(assessNativeSend({content:[{type:'text',text:'{"code":"POLICY_DENIED"}'}],isError:true},target,'ref').outcome,'policy-denied');
 assert.equal(assessNativeSend(native('manager',{huge:'x'.repeat(10000)}),target,'ref').outcome,'unknown');
 assert.ok(assessNativeSend(native('manager',{huge:'x'.repeat(10000)}),target,'ref').evidence.detail.length<3000);
 assert.ok(assessNativeSend(native('x'.repeat(10000)),target,'ref').evidence.detail.length<3000);
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 for(const scenario of ['success','unknown','denied','prepare-failure','send-failure','result-failure','replay']){
  const calls=[],outputs=[];
  const tools={mcp__team_context__team_context_submit:async r=>{calls.push('submit');return {status:'submitted'};},mcp__team_context__team_context_notice:async r=>{calls.push(r.action);if(r.action==='prepare'){if(scenario==='prepare-failure')throw Error('prepare disk');return {status:'ready_to_send',sendNow:true,replayed:scenario==='replay',hostRequest:target,attemptId:'attempt'};}if(scenario==='result-failure')throw Error('result disk');assert.equal(r.result.outcome,scenario==='denied'?'policy-denied':['unknown','send-failure'].includes(scenario)?'unknown':'accepted');return {status:'recorded'};},mcp__codex_app__send_message_to_thread:async r=>{calls.push('send');assert.equal(r.threadId,'manager');if(scenario==='send-failure')throw Error('timeout');if(scenario==='denied')return {content:[{type:'text',text:'{"code":"POLICY_DENIED"}'}],isError:true};return native(scenario==='unknown'?'other':'manager');}};
  await new AsyncFunction('ALL_TOOLS','tools','text',template.replace('hostSendAuthorized = false','hostSendAuthorized = true').replace('notificationMode = null',"notificationMode = 'legacy'"))(Object.keys(tools).map(name=>({name})),tools,v=>outputs.push(v));
  assert.deepEqual(calls,scenario==='prepare-failure'||scenario==='replay'?['submit','prepare']:['submit','prepare','send','result']);assert.equal(outputs[0].submission,'submitted');assert.equal(outputs[0].nextAction==='await-manager-review',scenario==='success');
 }
});

test('fixed native flow rejects queue_first or unknown modes before any tool; observe retains its legacy route',async()=>{
 const template=await readFile(new URL('../docs/optimization/functions-exec-submit-template.js',import.meta.url),'utf8');
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 for(const notificationMode of ['queue_first',null,undefined,'unavailable']){
  const calls=[];
  const invoke=async()=>{calls.push('unexpected');throw Error('must not call');};
  const result=await runRoutedSubmission({notificationMode,request,noticeOperationId:'notice',submit:invoke,prepare:invoke,send:invoke,record:invoke});
  assert.equal(result.stage,'route');
  assert.equal(result.nextAction,notificationMode==='queue_first'?'use-manager-inbox-no-native-fallback':'verify-installed-inbox-mode');
  const script=template.replace('hostSendAuthorized = false','hostSendAuthorized = true').replace('notificationMode = null',`notificationMode = ${JSON.stringify(notificationMode) ?? 'undefined'}`);
  await assert.rejects(new AsyncFunction('ALL_TOOLS','tools','text',script)([],{},invoke),/legacy\/observe mode required/);
  assert.deepEqual(calls,[]);
 }
 const calls=[];
 const result=await runRoutedSubmission({notificationMode:'observe',request,noticeOperationId:'notice',submit:async()=>{calls.push('submit');return {status:'submitted'};},prepare:async()=>{calls.push('prepare');return {status:'held',sendNow:false};},send:async()=>{calls.push('send');}});
 assert.equal(result.stage,'prepare');assert.deepEqual(calls,['submit','prepare']);
});
