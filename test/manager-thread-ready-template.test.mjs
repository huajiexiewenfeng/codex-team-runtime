import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../skills/manager-session/scripts/functions-exec-thread-ready-template.js',import.meta.url),'utf8');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const sentinel = 'PRIVATE_THREAD_BODY_ERROR_SENTINEL';
const local = {hostId:'local',threadId:'fixture-thread'};
const request = (extra={}) => ({target:local,dispatchAuthorized:true,verifiedLocalHostId:'local',...extra});
const completed = {id:'fixture-turn',status:'completed',error:null,items:[sentinel]};
const running = {...completed,status:'inProgress'};
const envelope = value => ({content:[{type:'text',text:JSON.stringify(value)}],isError:false});
const poll = (type, opts={}) => ({
  schemaVersion:1, cursor:sentinel, revision:10, changed:true,
  thread:{id:local.threadId,hostId:local.hostId,
    status:{type,...(type==='active' ? {activeFlags:['waitingOnApproval']} : {}),body:sentinel}},
  latestTurn:completed, latestAssistantMessage:{text:sentinel}, history:[sentinel], ...opts
});
const body = (...polls) => ({polls,timedOut:true,wake:null});
const snap = (type,opts) => envelope(body(poll(type,opts)));
const navigation = envelope({navigated:true,threadId:local.threadId,text:sentinel});
const wait = ['wait_threads',{targets:[local],timeoutMs:0}];
const open = ['navigate_to_codex_page',{threadId:local.threadId}];

async function run(req, observations, nav=navigation, available=true) {
 const calls=[], outputs=[], accesses=[];
 const tools = new Proxy({}, {get(_target,name) {
  accesses.push(name);
  switch(name){
   case 'mcp__codex_app__wait_threads':return async input=>{
    calls.push(['wait_threads',structuredClone(input)]);
    const result=observations.shift();
    if(result instanceof Error)throw result;
    return result;
   };
   case 'mcp__codex_app__navigate_to_codex_page':return available ? async input=>{
    calls.push(['navigate_to_codex_page',structuredClone(input)]);
    if(nav instanceof Error)throw nav;
    return nav;
   } : undefined;
   default: return undefined;
  }
 }});
 const filled=source.replace(
   'const request = {target: null, dispatchAuthorized: false, verifiedLocalHostId: null};',
   'const request = '+JSON.stringify(req)+';');
 await new AsyncFunction('tools','text',filled)(tools,value=>outputs.push(value));
 assert.equal(outputs.length,1);
 assert.ok(!JSON.stringify(outputs).includes(sentinel));
 assert.ok(accesses.every(name=>['mcp__codex_app__wait_threads','mcp__codex_app__navigate_to_codex_page'].includes(name)));
 return {out:outputs[0],calls,accesses};
}

test('idle uses only the original immediate exact query; remote idle needs no navigation',async()=>{
 const remote={...local,hostId:'remote-A'};
 for(const t of [local,remote]){
  const {out,calls,accesses}=await run(request({target:t}),[snap('idle',{thread:{id:t.threadId,hostId:t.hostId,status:{type:'idle'}}})]);
  assert.equal(out.state,'ready');assert.equal(out.reason,'already_idle');
  assert.equal(out.navigation,'not_attempted');assert.equal(out.after,null);
  assert.deepEqual(calls,[['wait_threads',{targets:[t],timeoutMs:0}]]);
  assert.equal(accesses.length,1);
 }
});

test('notLoaded opens once, rechecks exact idle and only reports bounded metadata',async()=>{
 for(const latestTurn of [completed,null]){
  const {out,calls}=await run(request(),[snap('notLoaded',{latestTurn}),
    {structuredContent:body(poll('idle',{latestTurn,revision:11}))}]);
  assert.deepEqual(calls,[wait,open,wait]);
  assert.deepEqual(out,{state:'ready',reason:'idle_after_navigation',target:local,
   navigation:'acknowledged',before:{threadStatus:'notLoaded',
    turn:latestTurn && {id:completed.id,status:'completed',error:'none'},revision:10},
   after:{threadStatus:'idle',turn:latestTurn && {id:completed.id,status:'completed',error:'none'},revision:11}});
 }
});

test('no dispatch authorization or invalid input makes zero tool accesses',async()=>{
 for(const req of [request({dispatchAuthorized:false}),request({dispatchAuthorized:'true'}),
   request({target:{...local,threadId:'client-123'}}),request({target:{...local,afterCursor:'stale'}}),
   request({verifiedLocalHostId:undefined}),request({extra:sentinel})]){
  const {out,calls,accesses}=await run(req,[]);
  assert.equal(out.state,'hold');assert.deepEqual(calls,[]);assert.deepEqual(accesses,[]);
 }
});

test('first snapshot holds on busy, system error, unknown, conflicting evidence and failures',async()=>{
 for(const obs of [snap('active'),snap('systemError'),snap('ended'),snap('future-status'),
   snap('idle',{latestTurn:running}),snap('notLoaded',{latestTurn:running}),
   snap('idle',{latestTurn:{...completed,error:{message:sentinel}}}),
   snap('idle',{latestTurn:{...completed,status:'future-turn'}}),snap('idle',{cursor:''}),
   snap('idle',{schemaVersion:2}),snap('idle',{revision:'10'}),
   snap('idle',{thread:{id:local.threadId,hostId:'other',status:{type:'idle'}}}),
   snap('idle',{thread:{id:'other',hostId:local.hostId,status:{type:'idle'}}}),
   snap('idle',{thread:{id:local.threadId,hostId:local.hostId,status:{type:'idle',activeFlags:[]}}}),
   envelope(body(poll('idle'),poll('idle'))),envelope({...body(poll('idle')),errors:[sentinel]}),
   envelope({...body(poll('idle')),wake:{reason:'turnCompleted',...local,turnId:'other-turn'}}),
   {content:[{type:'text',text:sentinel}]},new Error(sentinel)]){
  const {out,calls,accesses}=await run(request(),[obs]);
  assert.equal(out.state,'hold');assert.deepEqual(calls,[wait]);assert.equal(accesses.length,1);
 }
});

test('notLoaded on a remote, unverified or unsupported local host never navigates',async()=>{
 const remote={...local,hostId:'remote-A'};
 for(const [req,obs,available,reason] of [
   [request({target:remote,verifiedLocalHostId:remote.hostId}),
    snap('notLoaded',{thread:{id:remote.threadId,hostId:remote.hostId,status:{type:'notLoaded'}}}),
    true,'same_local_host_not_verified'],
   [request({verifiedLocalHostId:null}),snap('notLoaded'),true,'same_local_host_not_verified'],
   [request(),snap('notLoaded'),false,'navigation_unavailable']
 ]){
  const {out,calls}=await run(req,[obs],navigation,available);
  assert.equal(out.state,'unsupported');assert.equal(out.reason,reason);
  assert.deepEqual(calls,[['wait_threads',{targets:[req.target],timeoutMs:0}]]);
 }
});

test('navigation refusal, exception or wrong identity does not recheck or report ready',async()=>{
 for(const nav of [new Error(sentinel),{isError:true,structuredContent:{navigated:true}},
  envelope({navigated:false,reason:sentinel}),envelope({navigated:'true'}),
  envelope({navigated:true,threadId:'other'}),envelope({navigated:true,hostId:'remote-A'})]){
  const {out,calls}=await run(request(),[snap('notLoaded')],nav);
  assert.equal(out.state,'hold');assert.equal(out.navigation,'attempted');
  assert.deepEqual(calls,[wait,open]);assert.equal(out.after,null);
 }
});

test('acknowledgement is not readiness; one recheck holds on stale, conflicting or newer evidence',async()=>{
 for(const [obs,reason] of [[snap('notLoaded'),'notLoaded'],[snap('active'),'active'],
   [snap('systemError'),'systemError'],[snap('future'),'invalid_thread_status'],
   [snap('idle',{latestTurn:running}),'unfinished_turn'],
   [snap('idle',{latestTurn:{...completed,id:'next-turn'}}),'latest_turn_changed'],
   [snap('idle',{latestTurn:null}),'latest_turn_changed'],
   [snap('idle',{latestTurn:{...completed,status:'failed'}}),'latest_turn_changed'],
   [snap('idle',{revision:9}),'revision_regressed'],
   [snap('idle',{thread:{id:local.threadId,hostId:'remote-A',status:{type:'idle'}}}),'identity_mismatch'],
   [snap('idle',{thread:{id:'other',hostId:local.hostId,status:{type:'idle'}}}),'identity_mismatch'],
   [envelope(body(poll('idle'),poll('idle'))),'non_unique_poll'],
   [{isError:true,content:[{type:'text',text:sentinel}]},'invalid_poll_envelope'],
   [new Error(sentinel),'poll_exception']]){
  const {out,calls}=await run(request(),[snap('notLoaded'),obs]);
  assert.equal(out.state,'hold');assert.equal(out.reason,reason);
  assert.equal(out.navigation,'acknowledged');assert.deepEqual(calls,[wait,open,wait]);
 }
 const unknownBefore=await run(request(),[snap('notLoaded',{latestTurn:null}),snap('idle')]);
 assert.equal(unknownBefore.out.reason,'latest_turn_changed');
 assert.deepEqual(unknownBefore.calls,[wait,open,wait]);
});

test('pasteable Manager source has no imports, files, timers, send or Worker recall',()=>{
 assert.doesNotMatch(source,/\b(?:import|require|setTimeout|setInterval|notify|send_message_to_thread|team_context)\s*\(/);
 assert.deepEqual([...new Set(source.match(/tools\.\w+/g))].sort(),[
  'tools.mcp__codex_app__navigate_to_codex_page','tools.mcp__codex_app__wait_threads']);
});

const terminalWake = (type, latestTurn, {wake: overrides={}, timedOut=false}={}) =>
 envelope({...body(poll(type,{latestTurn})),timedOut,wake:{
  reason:'turnCompleted',...local,turnId:latestTurn.id,...overrides
 }});

test('matching idle terminal wake confirms readiness and preserves the observed outcome',async()=>{
 for(const [status,error] of [['completed',null],['interrupted',null],
   ['failed',null],['failed',{message:sentinel}]]){
  const latestTurn={...completed,status,error};
  const {out,calls}=await run(request(),[terminalWake('idle',latestTurn)]);
  assert.deepEqual(calls,[wait]);
  assert.equal(out.state,'ready',status);
  assert.equal(out.reason,'already_idle');
  assert.equal(out.navigation,'not_attempted');
  assert.equal(out.before.turn.status,status);
  assert.equal(out.before.turn.error,error ? 'present_unknown' : 'none');
 }
});

test('local notLoaded recheck accepts a matching terminal wake without rewriting its outcome',async()=>{
 for(const [status,error] of [['interrupted',null],['failed',null],['failed',{message:sentinel}]]){
  const latestTurn={...completed,status,error};
  const {out,calls}=await run(request(),[snap('notLoaded',{latestTurn}),terminalWake('idle',latestTurn)]);
  assert.deepEqual(calls,[wait,open,wait]);
  assert.equal(out.state,'ready',status);
  assert.equal(out.reason,'idle_after_navigation');
  assert.equal(out.after.turn.status,status);
  assert.deepEqual(out.before.turn,out.after.turn);
 }
});

test('terminal wake must still match the exact idle poll, its turn and the allowed wake schema',async()=>{
 const interrupted={...completed,status:'interrupted'};
 for(const obs of [
  terminalWake('active',interrupted),terminalWake('idle',running),
  terminalWake('idle',interrupted,{wake:{hostId:'remote-A'}}),
  terminalWake('idle',interrupted,{wake:{threadId:'different-thread'}}),
  terminalWake('idle',interrupted,{wake:{turnId:'different-turn'}}),
  terminalWake('idle',interrupted,{wake:{reason:'future-wake'}}),
  terminalWake('idle',interrupted,{wake:{body:sentinel}}),
  terminalWake('idle',interrupted,{timedOut:true}),
  terminalWake('idle',{...completed,error:{message:sentinel}}),
  terminalWake('idle',{...completed,status:'failed',error:sentinel})
 ]){
  const {out,calls}=await run(request(),[obs]);
  assert.equal(out.state,'hold');
  assert.deepEqual(calls,[wait]);
 }
});

test('a valid terminal wake during load cannot hide a changed turn or regressed revision',async()=>{
 const failed={...completed,status:'failed',error:null};
 for(const [latestTurn,revision,reason] of [
  [{...failed,id:'new-terminal-turn'},10,'latest_turn_changed'],
  [failed,9,'revision_regressed']
 ]){
  const after=envelope({...body(poll('idle',{latestTurn,revision})),timedOut:false,
   wake:{reason:'turnCompleted',...local,turnId:latestTurn.id}});
  const {out,calls}=await run(request(),[snap('notLoaded',{latestTurn:failed}),after]);
  assert.deepEqual(calls,[wait,open,wait]);
  assert.equal(out.state,'hold');
  assert.equal(out.reason,reason);
 }
});
