import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../skills/manager-session/scripts/functions-exec-wait-template.js',import.meta.url),'utf8');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const sentinel = 'PRIVATE_BODY_COMMAND_ERROR_SENTINEL';
const target = (n,hostId='fixture-host') => ({hostId,threadId:'fixture-'+n});
const req = (...targets) => ({targets,timeoutMs:0});
const poll = (t,extras={}) => ({
  schemaVersion:1,cursor:'opaque-'+t.threadId,revision:123,changed:true,
  thread:{id:t.threadId,hostId:t.hostId,status:{type:'active',activeFlags:[sentinel]}},
  latestTurn:{id:'turn-'+t.threadId,status:'inProgress',error:null},
  latestAssistantMessageId:sentinel,
  latestAssistantMessage:{phase:'commentary',text:sentinel},
  latestToolMarker:{type:'commandExecution',name:sentinel,status:'completed',output:sentinel},
  finalReply:sentinel,history:[sentinel],...extras
});
const decoded = polls => ({timedOut:true,wake:null,polls});

test('observed turnCompleted wake preserves reason and exact identity only after poll validation',async()=>{
 const a=target('00000000-0000-4000-8000-000000000001','local'),b=target(2);
 const turnId='00000000-0000-4000-8000-000000000002';
 const wake={reason:'turnCompleted',turnId,threadId:a.threadId,hostId:a.hostId};
 const p=poll(a,{latestTurn:{id:turnId,status:'completed',error:null}});
 p.thread.status.type='idle';
 const {out,calls}=await run(req(b,a),envelope({...decoded([p,poll(b)]),timedOut:false,wake}));
 assert.equal(calls.length,1);assert.deepEqual(out.wake,wake);
 assert.equal(out.timedOut,false);assert.equal(out.targets[1].turn.status,'completed');
 assert.ok(out.targets.every(t=>t.submissionRef===null));
});

test('wake host/thread/turn mismatch or absent/ambiguous poll stays bounded unknown',async()=>{
 const a=target(1),b=target(2),p=poll(a);
 p.thread.status.type='idle';p.latestTurn.status='completed';
 const wake={reason:'turnCompleted',turnId:p.latestTurn.id,threadId:a.threadId,hostId:a.hostId};
 const cases=[
  [{...wake,hostId:'foreign'},[p]],
  [{...wake,threadId:b.threadId},[p]],
  [{...wake,turnId:'other-turn'},[p]],
  [wake,[]],[wake,[p,p]],
  [wake,[p,poll({...a,hostId:'foreign'})]],
  [wake,[poll(a)]],
  [wake,[{...p,latestTurn:null}]],
  [wake,[{...p,schemaVersion:2}]]
 ];
 for(const [w,polls] of cases){
  const {out}=await run(req(a,b),envelope({...decoded(polls),timedOut:false,wake:w}));
  assert.equal(out.wake,'unknown');
  assert.ok(out.targets.every(t=>t.submissionRef===null));
 }
});

test('unknown wake reason, body injection and contradictory timeout are never forwarded',async()=>{
 const a=target(1),p=poll(a);
 p.thread.status.type='idle';p.latestTurn.status='completed';
 const wake={reason:'turnCompleted',turnId:p.latestTurn.id,threadId:a.threadId,hostId:a.hostId};
 for(const w of [{...wake,reason:sentinel},{...wake,text:sentinel},
   {...wake,body:{text:sentinel}},{...wake,turnId:sentinel},
   sentinel,{},[]]){
  const {out}=await run(req(a),envelope({...decoded([p]),timedOut:false,wake:w}));
  assert.equal(out.wake,'unknown');
  assert.equal(out.targets[0].turn.status,'completed');
 }
 const {out}=await run(req(a),envelope({...decoded([p]),timedOut:true,wake}));
 assert.equal(out.wake,'unknown');assert.equal(out.timedOut,true);
});

test('same thread on distinct verified hosts cannot borrow another hosts completion wake',async()=>{
 const a=target(1,'host-a'),b=target(1,'host-b'),p=poll(a),q=poll(b);
 p.thread.status.type='idle';p.latestTurn.status='completed';
 q.latestTurn.id='host-b-turn';
 const wake={reason:'turnCompleted',turnId:p.latestTurn.id,threadId:b.threadId,hostId:b.hostId};
 const {out}=await run(req(a,b),envelope({...decoded([q,p]),timedOut:false,wake}));
 assert.equal(out.wake,'unknown');
 assert.equal(out.targets[1].turn.status,'inProgress');
});
const envelope = v => ({content:[{type:'text',text:JSON.stringify(v)}],isError:false});
async function run(request,raw,refs=[],throws=false) {
  const calls=[],outputs=[];
  const tools = new Proxy({}, {get(_t,name) {
    assert.equal(name,'mcp__codex_app__wait_threads','no send/read/write/startup calls');
    return async r => {calls.push(structuredClone(r));if(throws)throw Error(sentinel);return raw;};
  }});
  // Execute the ENTIRE pasteable source with fake tools; replace only input declarations.
  const filled = source.replace('const request = {targets: [], timeoutMs: 0};',
    'const request = '+JSON.stringify(request)+';')
    .replace('const ledgerReferences = [];','const ledgerReferences = '+JSON.stringify(refs)+';');
  await new AsyncFunction('tools','text',filled)(tools,value=>outputs.push(value));
  assert.equal(outputs.length,1);
  assert.ok(!JSON.stringify(outputs).includes(sentinel),'native private data must not reach text');
  return {calls,out:outputs[0]};
}

test('one wait and compact projection on observed MCP polls, exact request/cursor',async()=>{
 const t={...target(1),afterCursor:'input-opaque'};
 const {calls,out}=await run(req(t),envelope(decoded([poll(t)])));
 assert.deepEqual(calls,[req(t)]);
 assert.equal(out.targets[0].cursor,'opaque-fixture-1');
 assert.equal(out.targets[0].threadStatus,'active');
 assert.equal(out.targets[0].turn.status,'inProgress');
 assert.equal(out.targets[0].submissionRef,null);
 assert.equal(out.timedOut,true);assert.equal(out.wake,'none');
 assert.equal(out.targets[0].revision,123);assert.equal(out.targets[0].changed,true);
 assert.deepEqual(Object.keys(out.targets[0]).sort(),
  ['hostId','threadId','threadStatus','turn','cursor','revision','changed','error','submissionRef'].sort());
});

test('eight out-of-order targets retain identity, completion and trusted ledger reference',async()=>{
 const targets=Array.from({length:8},(_,n)=>target(n));
 const polls=targets.map(t=>poll(t)).reverse();
 polls[0].thread.status.type='idle';
 polls[0].latestTurn.status='completed';
 const refs=[{...targets[7],submissionRef:'ledger:submission-7'}];
 const {calls,out}=await run(req(...targets),envelope({...decoded(polls),timedOut:false,wake:{text:sentinel}}),refs);
 assert.equal(calls.length,1);assert.equal(out.wake,'unknown');
 assert.equal(out.targets[7].turn.status,'completed');
 assert.equal(out.targets[7].threadStatus,'idle');
 assert.equal(out.targets[7].submissionRef,'ledger:submission-7');
 assert.ok(out.targets.slice(0,7).every(t=>t.submissionRef===null));
 for(const row of out.targets)assert.equal(row.cursor,'opaque-'+row.threadId);
});

test('same thread across two verified hosts is associated by both fields',async()=>{
 const a=target(1,'host-a'),b=target(1,'host-b');
 const {out}=await run(req(a,b),envelope(decoded([poll(b,{cursor:'cursor-b'}),poll(a,{cursor:'cursor-a'})])));
 assert.deepEqual(out.targets.map(t=>t.cursor),['cursor-a','cursor-b']);
});

test('missing, duplicate and foreign host never guess idle or use array order',async()=>{
 const a=target(1),b=target(2);
 const cases=[
  [[],['missing_poll','missing_poll']],
  [[poll(a),poll(a)],['duplicate_poll','missing_poll']],
  [[poll({...a,hostId:'foreign'})],['identity_conflict','missing_poll']],
  [[{...poll(a),thread:{id:a.threadId}}],['identity_conflict','missing_poll']]
 ];
 for(const [polls,errors] of cases){
  const {out}=await run(req(a,b),envelope(decoded(polls)));
  assert.deepEqual(out.targets.map(t=>t.error),errors);
  assert.ok(out.targets.every(t=>t.cursor===null&&t.threadStatus==='unknown'));
 }
});

test('mixed successful poll and unknown errors retain success and bounded error signal',async()=>{
 const a=target(1),b=target(2);
 const {out}=await run(req(a,b),envelope({...decoded([poll(a)]),errors:[{threadId:b.threadId,message:sentinel}]}));
 assert.equal(out.nativeErrors,'present_unknown');
 assert.equal(out.targets[0].threadStatus,'active');
 assert.equal(out.targets[1].error,'missing_poll');
 assert.equal(out.targets[1].threadStatus,'unknown');
});

test('host exceptions, error envelopes and malformed/unknown schema never leak or infer idle',async()=>{
 const a=target(1);
 const raws=[undefined,null,sentinel,{isError:true,content:[{type:'text',text:sentinel}]},
  {content:[{type:'text',text:sentinel}]},
  {content:[{type:'text',text:'{}'},{type:'text',text:sentinel}]},
  envelope({threads:[poll(a)],timedOut:true,wake:null}),
  envelope({...decoded([]),timedOut:'true'}),
  envelope({polls:[],timedOut:true}),
  envelope({...decoded([]),polls:Array(9).fill(poll(a))})];
 for(const raw of raws){
  const {out,calls}=await run(req(a),raw);
  assert.equal(calls.length,1);assert.equal(out.targets[0].threadStatus,'unknown');
  assert.equal(out.targets[0].cursor,null);
 }
 const {out}=await run(req(a),null,[],true);
 assert.equal(out.signal,'host_exception');
});

test('structuredContent same schema and turn error/body flags are safe',async()=>{
 const a=target(1);
 const {out}=await run(req(a),{structuredContent:decoded([poll(a,{
  latestTurn:{id:'turn-1',status:'failed',error:{message:sentinel}}})])});
 assert.equal(out.targets[0].turn.error,'present_unknown');
 assert.equal(out.targets[0].turn.status,'failed');
});

test('unsupported version/status/turn stays unknown',async()=>{
 const a=target(1);
 const {out}=await run(req(a),envelope(decoded([poll(a,{schemaVersion:2})])));
 assert.equal(out.targets[0].error,'unknown_poll');
 const p=poll(a);p.thread.status.type=sentinel;p.latestTurn.status=sentinel;
 const r=await run(req(a),envelope(decoded([p])));
 assert.equal(r.out.targets[0].threadStatus,'unknown');
 assert.equal(r.out.targets[0].turn.status,'unknown');
 const s=await run(req(a),envelope(decoded([poll(a,{latestTurn:{text:sentinel}})])));
 assert.equal(s.out.targets[0].turn,null);
 assert.equal(s.out.targets[0].error,'unknown_turn');
});

test('cursor is exact or unusable, never truncated; aggregate output is bounded',async()=>{
 const targets=[target(1),target(2),target(3)];
 const cursor='x'.repeat(2048);
 const {out}=await run(req(...targets),envelope(decoded(targets.map(t=>poll(t,{cursor})))));
 assert.equal(out.targets[0].cursor,cursor);assert.equal(out.targets[1].cursor,cursor);
 assert.equal(out.targets[2].cursor,null);assert.equal(out.targets[2].error,'unusable_cursor');
 for(const cursor of ['',null,'x'.repeat(2049)]){
  const r=await run(req(targets[0]),envelope(decoded([poll(targets[0],{cursor})])));
  assert.equal(r.out.targets[0].cursor,null);assert.equal(r.out.targets[0].error,'unusable_cursor');
 }
});

test('invalid inputs make zero calls and do not echo unsafe values',async()=>{
 const a=target(1);
 const invalid=[null,{},req(),req(...Array(9).fill(a)),req(a,a),
  req({...a,hostId:undefined}),req({...a,threadId:'client-new-thread:123'}),
  req({...a,threadId:'REPLACE_VERIFIED_THREAD'}),req({...a,afterCursor:''}),
  req({...a,afterCursor:'x'.repeat(2049)}),
  req(...[1,2,3].map(n=>({...target(n),afterCursor:'x'.repeat(2048)}))),
  {...req(a),timeoutMs:-1},{...req(a),timeoutMs:60001},{...req(a),timeoutMs:1.5},
  {...req(a),extra:sentinel},req({...a,extra:sentinel})];
 for(const request of invalid){
  const {out,calls}=await run(request,null);assert.equal(calls.length,0);
  assert.equal(out.signal,'invalid_input');assert.deepEqual(out.targets,[]);
 }
 for(const refs of [[{...target(2),submissionRef:'ledger'}],
   [{...a,submissionRef:'a'},{...a,submissionRef:'b'}],[{...a,submissionRef:''}],
   [{...a,submissionRef:'x'.repeat(257)}],[{...a,submissionRef:'ledger',extra:sentinel}]]){
  assert.equal((await run(req(a),null,refs)).calls.length,0);
 }
});

test('timeout without polls does not imply idle or completion, trusted references survive errors',async()=>{
 const a=target(1),refs=[{...a,submissionRef:'ledger:one'}];
 const {out}=await run(req(a),envelope(decoded([])),refs);
 assert.equal(out.timedOut,true);assert.equal(out.targets[0].threadStatus,'unknown');
 assert.equal(out.targets[0].submissionRef,'ledger:one');
 assert.equal((await run(req(a),null,refs,true)).out.targets[0].submissionRef,'ledger:one');
});

test('ended thread with no latest turn remains metadata, never a submission',async()=>{
 const a=target(1),p=poll(a,{latestTurn:null});
 p.thread.status.type='ended';
 const {out}=await run(req(a),envelope({...decoded([p]),timedOut:false,wake:{reason:sentinel}}));
 assert.equal(out.targets[0].threadStatus,'ended');assert.equal(out.targets[0].turn,null);
 assert.equal(out.targets[0].submissionRef,null);assert.equal(out.wake,'unknown');
});

test('pasteable source has no import/file/timer/notify dependencies',()=>{
 assert.doesNotMatch(source,/\b(?:import|require)\s*\(|^import\s|\b(?:setTimeout|setInterval|notify)\s*\(/m);
 assert.equal((source.match(/tools\./g)||[]).length,1);
});

test('worst-case escaped or Unicode fields cannot silently truncate output/cursors',async()=>{
 const targets=Array.from({length:8},(_,n)=>target(n));
 const refs=targets.map(t=>({...t,submissionRef:'字'.repeat(256)}));
 assert.equal((await run(req(...targets),null,refs)).calls.length,0);
 const polls=targets.map(t=>poll(t,{cursor:'字'.repeat(2048)}));
 const {out}=await run(req(...targets),envelope(decoded(polls)));
 const size=JSON.stringify(out).replace(/[^\x00-\x7F]/g,'______').length;
 assert.ok(size<=14000);
 if(out.signal==='output_limit')assert.ok(out.targets.every(t=>t.cursor===null));
 else assert.ok(out.targets.every(t=>t.cursor===null||t.cursor==='字'.repeat(2048)));
});
