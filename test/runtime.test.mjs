import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState, evolve, snapshot, validate } from '../src/runtime.mjs';
import { initialize, transact, readState } from '../src/store.mjs';
import { render } from '../src/render.mjs';
import { run } from '../src/cli.mjs';

const at = n => new Date(Date.UTC(2026, 8, 5, 0, n)).toISOString();
const source = { kind: 'fixture', ref: 'test-case' };
const member = (id, role) => ({ id, role, name: id, lifecycle: 'active', binding: { status: 'bound', hostId: 'fixture-host', threadId: `fixture-${id}` } });
function setup() { return createState({ teamId: 'team', name: 'Team', source, members: [member('m','Manager'),member('l','Liaison'),member('w','Worker')] }, at(0)); }
function event(s, type, data = {}, n = 1, actor = 'm') { return evolve(s, { id: `e-${s.version}`, type, actor, at: at(n), source, ...data }, s.version); }
function assigned() { let s = event(setup(), 'openRound', { roundId:'r', title:'Round' }); return event(s,'assign',{roundId:'r',taskId:'t',title:'Task',workerId:'w',required:true,assignedAt:at(2)},2); }
function approved() { let s = assigned(); s=event(s,'submit',{roundId:'r',taskId:'t',summary:'delivery'},3,'w'); s=event(s,'review',{roundId:'r',taskId:'t'},4); return event(s,'approve',{roundId:'r',taskId:'t',summary:'independent check',evidence:['test:pass']},5); }

test('submission is not approval; rework requires resubmission and independent review', () => {
 let s=assigned(); s=event(s,'submit',{roundId:'r',taskId:'t',summary:'final'},3,'w');
 assert.equal(s.tasks[0].status,'submitted');
 assert.throws(()=>event(s,'closeRound',{roundId:'r'},4));
 assert.throws(()=>event(s,'approve',{roundId:'r',taskId:'t',summary:'ok',evidence:['x']},4));
 s=event(s,'review',{roundId:'r',taskId:'t'},4); s=event(s,'rework',{roundId:'r',taskId:'t',summary:'fix test'},5);
 assert.throws(()=>event(s,'approve',{roundId:'r',taskId:'t',summary:'ok',evidence:['x']},6));
 s=event(s,'submit',{roundId:'r',taskId:'t',summary:'fixed'},6,'w'); s=event(s,'review',{roundId:'r',taskId:'t'},7);
 assert.throws(()=>event(s,'approve',{roundId:'r',taskId:'t',summary:'self',evidence:['x']},8,'w'));
 s=event(s,'approve',{roundId:'r',taskId:'t',summary:'retested',evidence:['test:pass']},8);
 assert.equal(s.tasks[0].status,'approved'); assert.equal(s.tasks[0].submissions,2);
});
test('waiting counts; stages accumulate; completed timing freezes; null is unknown', () => {
 let s=assigned(); s=event(s,'block',{roundId:'r',taskId:'t',summary:'waiting'},3);
 let v=snapshot(s,at(13)); assert.equal(v.tasks[0].elapsedMs,11*60000); assert.equal(v.tasks[0].phaseElapsedMs,10*60000);
 s=approved(); assert.equal(snapshot(s,at(50)).tasks[0].elapsedMs,3*60000); assert.equal(snapshot(s,at(50)).tasks[0].phaseElapsedMs,0);
 s=event(event(setup(),'openRound',{roundId:'r',title:'R'}),'assign',{roundId:'r',taskId:'t',title:'T',workerId:'w',required:true,assignedAt:null},2);
 assert.equal(snapshot(s,at(10)).tasks[0].elapsedMs,null);
});
test('observations keep original time, provenance and latest effective progress', () => {
 let s=assigned(); assert.equal(snapshot(s,at(3)).tasks[0].freshness,'unknown');
 s=event(s,'observe',{roundId:'r',taskId:'t',observedAt:at(3),summary:'built',progress:true},4,'w');
 s=event(s,'observe',{roundId:'r',taskId:'t',observedAt:at(2),summary:'late old',progress:false},5,'w');
 let v=snapshot(s,at(30)); assert.equal(v.tasks[0].freshness,'stale'); assert.equal(v.tasks[0].latestObservation.summary,'built'); assert.equal(v.tasks[0].latestProgress.summary,'built');
 s=event(s,'observe',{roundId:'r',taskId:'t',observedAt:null,summary:'unknown time',progress:true},6,'w');
 assert.equal(snapshot(s,at(30)).tasks[0].latestProgress.summary,'built');
});
test('round closure preserves roles, old events cannot stop new round, history queries read only', () => {
 let s=approved(); s=event(s,'openRound',{roundId:'new',title:'New'},6); s=event(s,'closeRound',{roundId:'r'},7);
 assert.equal(s.reporting.desired,'running'); assert.equal(s.rounds.find(r=>r.id==='new').status,'open');
 assert.equal(s.members[0].lifecycle,'active'); const before=JSON.stringify(s); snapshot(s,at(8),'r'); assert.equal(JSON.stringify(s),before);
 assert.throws(()=>event(s,'closeRound',{roundId:'r'},8));
});
test('stop intent and offline receipt never mean actual host stop; stale receipt rejected', () => {
 let s=event(approved(),'closeRound',{roundId:'r'},6); assert.equal(s.reporting.desired,'stopped'); assert.equal(s.reporting.actual,'unknown');
 const intentVersion=s.reporting.intentVersion;
 s=event(s,'reportReceipt',{intentVersion,actual:'stopped'},7); assert.equal(s.reporting.actual,'unknown'); assert.equal(s.reporting.offlineReceipt.actual,'stopped');
 s=event(s,'openRound',{roundId:'next',title:'Next'},8); assert.throws(()=>event(s,'reportReceipt',{intentVersion,actual:'stopped'},9));
});
test('bindings distinguish unbound, creating, missing and prevent assignment; history pins identity', () => {
 for (const status of ['unbound','creating','missing']) { let s=setup(); s.members[2].binding=status==='missing'?{status,hostId:'h',threadId:'t'}:status==='creating'?{status,pendingId:'pending'}:{status}; validate(s); s=event(s,'openRound',{roundId:'r',title:'R'}); assert.throws(()=>event(s,'assign',{roundId:'r',taskId:'t',title:'T',workerId:'w',required:true,assignedAt:at(2)},2)); assert.match(render(snapshot(s,at(3))),/disabled/); }
 const s=assigned(); assert.deepEqual(s.rounds[0].members[2].binding,s.members[2].binding);
});
test('validation rejects invalid versions, identity duplicates, bad time, unauthorized actor and unknown fields', () => {
 const s=assigned(); assert.throws(()=>evolve(s,{id:'x',type:'closeRound',actor:'m',at:at(4),source,roundId:'r'},0));
 assert.throws(()=>event(s,'observe',{roundId:'r',taskId:'t',summary:'x',progress:false,observedAt:'bad'},3,'w'));
 assert.throws(()=>event(s,'block',{roundId:'r',taskId:'t',summary:'x'},3,'l'));
 assert.throws(()=>event(s,'block',{roundId:'r',taskId:'t',summary:'x',surprise:true},3));
 const bad=structuredClone(s); bad.members[2].binding=bad.members[0].binding; assert.throws(()=>validate(bad));
});
test('atomic store rejects corrupted state, stale writes and duplicate init without overwrite', async () => {
 const dir=await mkdtemp(join(tmpdir(),'team-runtime-')); const file=join(dir,'state.json');
 await initialize(file,setup()); const original=await readFile(file,'utf8'); await assert.rejects(initialize(file,setup())); assert.equal(await readFile(file,'utf8'),original);
 await assert.rejects(transact(file,99,{id:'bad'})); assert.equal(await readFile(file,'utf8'),original);
 const e={id:'open',type:'openRound',roundId:'r',title:'R',actor:'m',at:at(1),source};
 const results=await Promise.allSettled([transact(file,0,e),transact(file,0,{...e,id:'other'})]); assert.equal(results.filter(x=>x.status==='fulfilled').length,1); assert.equal((await readState(file)).version,1);
 await writeFile(file,'{bad'); await assert.rejects(transact(file,1,e)); assert.equal(await readFile(file,'utf8'),'{bad');
});
test('HTML escapes all supplied text, disables navigation, renders the same immutable snapshot', () => {
 const s=assigned(); s.tasks[0].title='<script>alert("x")</script>'; const before=JSON.stringify(s); const v=snapshot(s,at(5)); const html=render(v);
 assert.match(html,/&lt;script&gt;/); assert.doesNotMatch(html,/<script|codex:\/\//); assert.match(html,/打开对话/); assert.match(html,/disabled/); assert.match(html,/fixture-w/); assert.match(html,/模拟来源/); assert.match(html,new RegExp(v.snapshotId));
 assert.equal(JSON.stringify(s),before); assert.equal(render(v),html); assert.equal(v.sourceVersion,s.version);
});
test('CLI demo exports matching JSON and HTML; snapshot queries never mutate state or overwrite output', async () => {
 const dir=await mkdtemp(join(tmpdir(),'team-cli-')); const dest=join(dir,'demo');
 await run(['demo',dest],()=>{}); const file=join(dest,'state.json'); const before=await readFile(file,'utf8');
 const v=JSON.parse(await readFile(join(dest,'view','snapshot.json'),'utf8')); const html=await readFile(join(dest,'view','index.html'),'utf8');
 assert.equal(html,render(v)); assert.match(html,/模拟来源/); assert.equal(v.tasks.length,4);
 await run(['snapshot',file,join(dir,'query'),at(120),'round-demo'],()=>{}); assert.equal(await readFile(file,'utf8'),before);
 await assert.rejects(run(['snapshot',file,dest,at(120)],()=>{})); assert.equal(await readFile(file,'utf8'),before);
 await assert.rejects(run(['demo',dest],()=>{}));
});
test('report preference persists across rounds and old round bindings survive later rebind', () => {
 let s=event(approved(),'closeRound',{roundId:'r'},6);
 s=event(s,'bindMember',{memberId:'w',binding:{status:'bound',hostId:'other',threadId:'new-worker'}},7);
 assert.equal(snapshot(s,at(8),'r').members.find(m=>m.id==='w').binding.threadId,'fixture-w');
 s=event(s,'reports',{enabled:false},8); s=event(s,'openRound',{roundId:'next',title:'Next'},9);
 assert.equal(s.reporting.desired,'stopped'); assert.equal(s.reporting.enabled,false);
});
test('semantically corrupt JSON and future state timestamps are rejected before writes', async () => {
 const s=assigned(); s.tasks[0].stages[0].startedAt=at(50); s.tasks[0].assignedAt=at(50);
 assert.throws(()=>validate(s));
 const dir=await mkdtemp(join(tmpdir(),'team-bad-')); const file=join(dir,'state.json'); const bytes=JSON.stringify(s); await writeFile(file,bytes);
 await assert.rejects(transact(file,s.version,{id:'x'})); assert.equal(await readFile(file,'utf8'),bytes);
 const closed=approved(); closed.rounds[0].status='closed'; closed.rounds[0].closedAt=at(1); assert.throws(()=>validate(closed));
});
test('state validation catches forged phase history, submission counts and unknown audit events', () => {
 const a=approved(); a.tasks[0].submissions=0; assert.throws(()=>validate(a));
 const b=assigned(); b.events[0].type='bogus'; assert.throws(()=>validate(b));
 const c=approved(); c.tasks[0].stages[1].status='rework'; assert.throws(()=>validate(c));
});
test('CLI init and apply persist validated input; failed command leaves original bytes', async () => {
 const dir=await mkdtemp(join(tmpdir(),'team-command-')); const config=join(dir,'config.json'),file=join(dir,'state.json'),input=join(dir,'event.json'); const s=setup();
 await writeFile(config,JSON.stringify({teamId:s.team.id,name:s.team.name,source:s.team.source,members:s.members}));
 await run(['init',config,file,at(0)],()=>{});
 await writeFile(input,JSON.stringify({id:'open',type:'openRound',actor:'m',at:at(1),source,roundId:'r',title:'R'}));
 await run(['apply',file,input,'0'],()=>{}); assert.equal((await readState(file)).rounds[0].id,'r');
 const before=await readFile(file,'utf8'); await assert.rejects(run(['apply',file,input,'0'],()=>{})); assert.equal(await readFile(file,'utf8'),before);
});
